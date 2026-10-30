import { randomUUID } from "node:crypto";
import { z } from "zod";
import { totals } from "../shared/catalog.js";
import { productFromRow, orderFromRow } from "./db.js";
import { digest, HttpError } from "./security.js";
export const addressSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: z
      .string()
      .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number."),
    line1: z.string().trim().min(5).max(180),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    postalCode: z
      .string()
      .regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code."),
  })
  .strict();
export const checkoutSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().max(80),
            quantity: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    address: addressSchema,
    coupon: z.string().trim().max(20).default(""),
    paymentMethod: z.enum(["cod", "stripe"]),
  })
  .strict();

export async function createOrder(db, user, raw, key) {
  const input = checkoutSchema.parse(raw);
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key || ""))
    throw new HttpError(400, "A valid checkout request key is required.");
  if (new Set(input.items.map((i) => i.id)).size !== input.items.length)
    throw new HttpError(400, "Duplicate product entries are not allowed.");
  input.coupon = input.coupon.toUpperCase();
  if (input.coupon && input.coupon !== "AUREL10")
    throw new HttpError(400, "This offer code is not valid.");
  const requestHash = digest(JSON.stringify(input));
  // Sorting guarantees a consistent row lock order for PostgreSQL concurrent checkouts.
  input.items.sort((a, b) => a.id.localeCompare(b.id));
  return db.transaction(async (tx) => {
    // Per-customer serialization also protects retries before the unique key is inserted.
    await tx.get("SELECT id FROM users WHERE id=$1" + tx.lock, [user.id]);
    const previous = await tx.get(
      "SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2",
      [user.id, key],
    );
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new HttpError(
          409,
          "This checkout key was already used for a different order.",
        );
      return orderFromRow(previous);
    }
    const items = [];
    for (const item of input.items) {
      const row = await tx.get(
        "SELECT * FROM products WHERE id=$1 AND active=1" + tx.lock,
        [item.id],
      );
      if (!row)
        throw new HttpError(400, "An item in your bag is no longer available.");
      const p = productFromRow(row);
      const updated = await tx.run(
        "UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock>=$1",
        [item.quantity, item.id],
      );
      if (!updated.changes)
        throw new HttpError(
          409,
          `${p.name}: only ${p.stock} available. Please update your bag.`,
        );
      items.push({
        id: p.id,
        name: p.name,
        image: p.image,
        price: p.price,
        quantity: item.quantity,
      });
    }
    const calc = totals(items, input.coupon);
    const id = "AU-" + randomUUID().slice(0, 12).toUpperCase();
    const data = {
      items,
      address: input.address,
      coupon: input.coupon,
      email: user.email,
      ...calc,
    };
    const status =
      input.paymentMethod === "cod" ? "confirmed" : "awaiting_payment";
    await tx.run(
      "INSERT INTO orders(id,user_id,idempotency_key,request_hash,data,total,status,payment_method,payment_status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        user.id,
        key,
        requestHash,
        JSON.stringify(data),
        calc.total,
        status,
        input.paymentMethod,
        "unpaid",
        Date.now(),
      ],
    );
    return orderFromRow(await tx.get("SELECT * FROM orders WHERE id=$1", [id]));
  });
}

export async function changeOrderStatus(db, id, status, actor) {
  return db.transaction(async (tx) => {
    const row = await tx.get("SELECT * FROM orders WHERE id=$1" + tx.lock, [
      id,
    ]);
    if (!row) throw new HttpError(404, "Order not found.");
    if (row.status === status) return orderFromRow(row);
    // Re-check under the row lock: a payment webhook can win the race with expiry.
    if (
      actor === "stripe" &&
      (row.payment_status === "paid" || row.status !== "awaiting_payment")
    )
      return orderFromRow(row);
    const allowed = {
      confirmed: ["processing", "cancelled"],
      processing: ["shipped", "cancelled"],
      shipped: ["delivered"],
      awaiting_payment: ["cancelled"],
      delivered: [],
      cancelled: [],
    };
    if (!allowed[row.status]?.includes(status))
      throw new HttpError(409, "That order status transition is not allowed.");
    if (
      row.payment_method === "stripe" &&
      status === "cancelled" &&
      actor !== "stripe"
    )
      throw new HttpError(
        409,
        "Card orders must be reconciled through Stripe. Expired sessions are cancelled by webhook; paid refunds require a separate refund workflow.",
      );
    if (status === "cancelled")
      for (const item of JSON.parse(row.data).items)
        await tx.run("UPDATE products SET stock=stock+$1 WHERE id=$2", [
          item.quantity,
          item.id,
        ]);
    const payment =
      status === "delivered" && row.payment_method === "cod"
        ? "paid"
        : row.payment_status;
    await tx.run("UPDATE orders SET status=$1,payment_status=$2 WHERE id=$3", [
      status,
      payment,
      id,
    ]);
    await tx.run(
      "INSERT INTO audit_logs(id,actor_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), actor, `order:${status}`, id, Date.now()],
    );
    return orderFromRow(await tx.get("SELECT * FROM orders WHERE id=$1", [id]));
  });
}

export async function settleStripeEvent(db, event) {
  const session = event.data.object;
  const id = session.metadata?.orderId;
  if (!id) return;
  if (event.type === "checkout.session.expired") {
    const row = await db.get("SELECT * FROM orders WHERE id=$1", [id]);
    if (row?.status === "awaiting_payment" && row.stripe_session === session.id)
      await changeOrderStatus(db, id, "cancelled", "stripe");
    return;
  }
  if (
    event.type !== "checkout.session.completed" ||
    session.payment_status !== "paid"
  )
    return;
  await db.transaction(async (tx) => {
    const row = await tx.get("SELECT * FROM orders WHERE id=$1" + tx.lock, [
      id,
    ]);
    if (!row)
      throw new HttpError(409, "Order is not yet available. Retry webhook.");
    if (
      row.payment_method !== "stripe" ||
      row.total !== session.amount_total ||
      session.currency !== "inr" ||
      (row.stripe_session && row.stripe_session !== session.id)
    )
      throw new HttpError(400, "Payment does not match order.");
    if (row.payment_status === "paid") return;
    if (row.status === "cancelled")
      throw new HttpError(
        409,
        "Cancelled order requires manual reconciliation.",
      );
    await tx.run(
      "UPDATE orders SET payment_status=$1,status=$2,stripe_session=$3 WHERE id=$4",
      ["paid", "confirmed", session.id, id],
    );
  });
}
