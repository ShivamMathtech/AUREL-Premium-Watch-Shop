import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { connectDatabase, initializeDatabase } from "../server/db.js";
import {
  createOrder,
  changeOrderStatus,
  settleStripeEvent,
} from "../server/orders.js";
import { createApp } from "../server/app.js";
import { rateLimit, hashPassword, verifyPassword } from "../server/security.js";
import { totals } from "../shared/catalog.js";

const address = {
  name: "Test Customer",
  phone: "9876543210",
  line1: "12 Test Road",
  city: "Dehradun",
  state: "Uttarakhand",
  postalCode: "248001",
};
const checkout = (overrides = {}) => ({
  items: [{ id: "verde-automatic", quantity: 1 }],
  address,
  coupon: "",
  paymentMethod: "cod",
  ...overrides,
});
const adminPassword = "Local-test-password-123!";
async function fixture(t) {
  const db = await connectDatabase({ path: ":memory:", url: "" });
  await initializeDatabase(db, {
    adminEmail: "admin@example.com",
    adminPassword,
  });
  const user = {
    id: randomUUID(),
    name: "Test Customer",
    email: "customer@example.com",
  };
  await db.run(
    "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      user.id,
      user.name,
      user.email,
      await hashPassword("Customer-test-123!"),
      "customer",
      Date.now(),
    ],
  );
  t.after(() => db.close());
  return { db, user };
}
async function apiFixture(t, options = {}) {
  const f = await fixture(t);
  const app = createApp({ database: f.db, ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(() => new Promise((r) => server.close(r)));
  async function request(
    path,
    { method = "GET", body, cookie, headers = {} } = {},
  ) {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Aurel-Client": "storefront",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
      headers: res.headers,
    };
  }
  return { ...f, request, base };
}

test("seed is idempotent and preserves stock edits; passwords are salted", async (t) => {
  const { db } = await fixture(t);
  await db.run("UPDATE products SET stock=4 WHERE id=$1", ["verde-automatic"]);
  await initializeDatabase(db, {});
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    4,
  );
  assert.equal((await db.all("SELECT * FROM products")).length, 4);
  const a = await hashPassword("same-password"),
    b = await hashPassword("same-password");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("same-password", a));
  assert.equal(await verifyPassword("wrong-password", a), false);
});
test("price, discount and delivery are calculated on the server", async (t) => {
  const { db, user } = await fixture(t);
  const o = await createOrder(
    db,
    user,
    checkout({ coupon: "aurel10" }),
    randomUUID(),
  );
  assert.equal(o.subtotal, 2490000);
  assert.equal(o.discount, 249000);
  assert.equal(o.shipping, 0);
  assert.equal(o.total, 2241000);
  assert.equal(o.paymentStatus, "unpaid");
  assert.equal(totals([{ price: 50000, quantity: 1 }]).shipping, 29900);
  await assert.rejects(
    createOrder(
      db,
      user,
      checkout({ items: [{ id: "oro-classic", quantity: 1, price: 1 }] }),
      randomUUID(),
    ),
  );
  await assert.rejects(
    createOrder(db, user, checkout({ coupon: "INVALID" }), randomUUID()),
    (e) => e.status === 400,
  );
});
test("concurrent retries create one order and decrement stock once", async (t) => {
  const { db, user } = await fixture(t);
  const key = randomUUID();
  const out = await Promise.all([
    createOrder(db, user, checkout(), key),
    createOrder(db, user, checkout(), key),
  ]);
  assert.equal(out[0].id, out[1].id);
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    17,
  );
  assert.equal((await db.all("SELECT * FROM orders")).length, 1);
  await assert.rejects(
    createOrder(db, user, checkout({ coupon: "AUREL10" }), key),
    (e) => e.status === 409,
  );
});
test("concurrent buyers cannot oversell the final watch", async (t) => {
  const { db, user } = await fixture(t);
  const other = {
    id: randomUUID(),
    name: "Second buyer",
    email: "second@example.com",
  };
  await db.run(
    "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6)",
    [other.id, other.name, other.email, "unused", "customer", Date.now()],
  );
  await db.run("UPDATE products SET stock=1 WHERE id=$1", ["verde-automatic"]);
  const out = await Promise.allSettled([
    createOrder(db, other, checkout(), randomUUID()),
    createOrder(db, user, checkout(), randomUUID()),
  ]);
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(
    out.filter((o) => o.status === "rejected")[0].reason.status,
    409,
  );
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    0,
  );
});
test("an invalid item rolls back all stock; duplicate item rows are rejected", async (t) => {
  const { db, user } = await fixture(t);
  await assert.rejects(
    createOrder(
      db,
      user,
      checkout({
        items: [
          { id: "bleu-diver", quantity: 1 },
          { id: "zz-missing", quantity: 1 },
        ],
      }),
      randomUUID(),
    ),
    (e) => e.status === 400,
  );
  assert.equal(
    (await db.get("SELECT stock FROM products WHERE id=$1", ["bleu-diver"]))
      .stock,
    16,
  );
  await assert.rejects(
    createOrder(
      db,
      user,
      checkout({
        items: [
          { id: "verde-automatic", quantity: 1 },
          { id: "verde-automatic", quantity: 1 },
        ],
      }),
      randomUUID(),
    ),
    (e) => e.status === 400,
  );
});
test("cancellation restocks exactly once and delivery collects COD", async (t) => {
  const { db, user } = await fixture(t);
  const o = await createOrder(db, user, checkout(), randomUUID());
  await changeOrderStatus(db, o.id, "cancelled", "admin");
  await changeOrderStatus(db, o.id, "cancelled", "admin");
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    18,
  );
  await assert.rejects(
    changeOrderStatus(db, o.id, "shipped", "admin"),
    (e) => e.status === 409,
  );
  const second = await createOrder(db, user, checkout(), randomUUID());
  for (const s of ["processing", "shipped", "delivered"])
    await changeOrderStatus(db, second.id, s, "admin");
  const row = await db.get("SELECT * FROM orders WHERE id=$1", [second.id]);
  assert.equal(row.payment_status, "paid");
});
test("registration, cookies, invalid credentials and logout", async (t) => {
  const { request } = await apiFixture(t);
  const bad = await request("/auth/register", {
    method: "POST",
    body: {
      name: "Test",
      email: "new@example.com",
      password: "New-password-123!",
      role: "admin",
    },
  });
  assert.equal(bad.status, 400);
  const created = await request("/auth/register", {
    method: "POST",
    body: {
      name: "New Customer",
      email: "new@example.com",
      password: "New-password-123!",
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, "customer");
  assert.match(created.headers.get("set-cookie"), /HttpOnly/);
  assert.match(created.headers.get("set-cookie"), /SameSite=Lax/);
  assert.equal(created.data.user.password_hash, undefined);
  const dup = await request("/auth/register", {
    method: "POST",
    body: {
      name: "New Customer",
      email: "NEW@example.com",
      password: "New-password-123!",
    },
  });
  assert.equal(dup.status, 409);
  assert.equal(
    (
      await request("/auth/login", {
        method: "POST",
        body: { email: "new@example.com", password: "wrong-password" },
      })
    ).status,
    401,
  );
  assert.ok((await request("/auth/me", { cookie: created.cookie })).data.user);
  await request("/auth/logout", {
    method: "POST",
    cookie: created.cookie,
    body: {},
  });
  assert.equal(
    (await request("/auth/me", { cookie: created.cookie })).data.user,
    null,
  );
});
test("customer isolation and administrator authorization are enforced on the backend", async (t) => {
  const { request, db, user } = await apiFixture(t);
  const order = await createOrder(db, user, checkout(), randomUUID());
  assert.equal((await request("/admin/summary")).status, 401);
  const customer = await request("/auth/register", {
    method: "POST",
    body: {
      name: "Other Customer",
      email: "other@example.com",
      password: "Other-password-123!",
    },
  });
  assert.equal(
    (await request("/admin/summary", { cookie: customer.cookie })).status,
    403,
  );
  assert.equal(
    (await request("/orders/" + order.id, { cookie: customer.cookie })).status,
    404,
  );
  assert.equal(
    (await request("/orders", { cookie: customer.cookie })).data.length,
    0,
  );
  assert.equal(
    (
      await request("/admin/orders/" + order.id, {
        method: "PATCH",
        cookie: customer.cookie,
        body: { status: "delivered" },
      })
    ).status,
    403,
  );
});
test("complete authenticated COD workflow, product edits and inventory concurrency guard", async (t) => {
  const { request } = await apiFixture(t);
  const login = await request("/auth/login", {
    method: "POST",
    body: { email: "customer@example.com", password: "Customer-test-123!" },
  });
  assert.equal(login.status, 200);
  const order = await request("/orders", {
    method: "POST",
    body: checkout(),
    cookie: login.cookie,
    headers: { "Idempotency-Key": randomUUID() },
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.status, "confirmed");
  const admin = await request("/auth/login", {
    method: "POST",
    body: { email: "admin@example.com", password: adminPassword },
  });
  assert.equal(admin.status, 200);
  const summary = await request("/admin/summary", { cookie: admin.cookie });
  assert.equal(summary.data.stats.orders, 1);
  const original = summary.data.products.find(
    (p) => p.id === "verde-automatic",
  );
  const { id, ...product } = original;
  product.name = "Updated Verde";
  assert.equal(
    (
      await request("/admin/products/" + id, {
        method: "PUT",
        cookie: admin.cookie,
        body: product,
        headers: { "If-Stock": "999" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/admin/products/" + id, {
        method: "PUT",
        cookie: admin.cookie,
        body: product,
        headers: { "If-Stock": String(original.stock) },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/products")).data.find((p) => p.id === id).name,
    "Updated Verde",
  );
  for (const status of ["processing", "shipped", "delivered"])
    assert.equal(
      (
        await request("/admin/orders/" + order.data.id, {
          method: "PATCH",
          cookie: admin.cookie,
          body: { status },
        })
      ).status,
      200,
    );
  assert.equal(
    (await request("/admin/summary", { cookie: admin.cookie })).data.stats
      .revenue,
    2490000,
  );
});
test("CSRF, input validation, API 404s and persistent rate limits", async (t) => {
  const { request, db } = await apiFixture(t);
  assert.equal(
    (
      await request("/newsletter", {
        method: "POST",
        body: { email: "a@example.com", consent: true },
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/newsletter", {
        method: "POST",
        body: { email: "a@example.com", consent: true },
        headers: { "X-Aurel-Client": "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/newsletter", {
        method: "POST",
        body: { email: "not-an-email", consent: true },
      })
    ).status,
    400,
  );
  assert.equal((await request("/not-a-route")).status, 404);
  await rateLimit(db, "test-key", 2);
  await rateLimit(db, "test-key", 2);
  await assert.rejects(rateLimit(db, "test-key", 2), (e) => e.status === 429);
});
test("Stripe payment completion verifies amount and is idempotent", async (t) => {
  const { db, user } = await fixture(t);
  const o = await createOrder(
    db,
    user,
    checkout({ paymentMethod: "stripe" }),
    randomUUID(),
  );
  const event = {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        metadata: { orderId: o.id },
        payment_status: "paid",
        amount_total: o.total,
        currency: "inr",
      },
    },
  };
  await assert.rejects(
    settleStripeEvent(db, {
      ...event,
      data: { object: { ...event.data.object, amount_total: 1 } },
    }),
    (e) => e.status === 400,
  );
  await settleStripeEvent(db, event);
  await settleStripeEvent(db, event);
  const row = await db.get("SELECT * FROM orders WHERE id=$1", [o.id]);
  assert.equal(row.status, "confirmed");
  assert.equal(row.payment_status, "paid");
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    17,
  );
  await assert.rejects(
    changeOrderStatus(db, o.id, "cancelled", "admin"),
    (e) => e.status === 409,
  );
});
test("expired Stripe sessions release stock once and paid orders are not cancelled", async (t) => {
  const { db, user } = await fixture(t);
  const o = await createOrder(
    db,
    user,
    checkout({ paymentMethod: "stripe" }),
    randomUUID(),
  );
  await db.run("UPDATE orders SET stripe_session=$1 WHERE id=$2", [
    "cs_expired",
    o.id,
  ]);
  const expired = {
    type: "checkout.session.expired",
    data: { object: { id: "cs_expired", metadata: { orderId: o.id } } },
  };
  await settleStripeEvent(db, expired);
  await settleStripeEvent(db, expired);
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    18,
  );
  const paid = await createOrder(
    db,
    user,
    checkout({ paymentMethod: "stripe" }),
    randomUUID(),
  );
  await settleStripeEvent(db, {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_paid",
        metadata: { orderId: paid.id },
        payment_status: "paid",
        amount_total: paid.total,
        currency: "inr",
      },
    },
  });
  await changeOrderStatus(db, paid.id, "cancelled", "stripe");
  assert.equal(
    (await db.get("SELECT status FROM orders WHERE id=$1", [paid.id])).status,
    "confirmed",
  );
  assert.equal(
    (
      await db.get("SELECT stock FROM products WHERE id=$1", [
        "verde-automatic",
      ])
    ).stock,
    17,
  );
});
test("webhook rejects invalid signatures and accepts signed raw payloads", async (t) => {
  const secret = "whsec_local_test_only";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  t.after(() => delete process.env.STRIPE_WEBHOOK_SECRET);
  const stripe = new Stripe("sk_test_not_a_real_key");
  const { request, db, user } = await apiFixture(t, { stripeClient: stripe });
  const o = await createOrder(
    db,
    user,
    checkout({ paymentMethod: "stripe" }),
    randomUUID(),
  );
  const payload = JSON.stringify({
    id: "evt_local",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_signed",
        metadata: { orderId: o.id },
        payment_status: "paid",
        amount_total: o.total,
        currency: "inr",
      },
    },
  });
  assert.equal(
    (
      await request("/payments/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": "invalid" },
      })
    ).status,
    400,
  );
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(
    (
      await request("/payments/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": header },
      })
    ).status,
    200,
  );
  assert.equal(
    (await db.get("SELECT payment_status FROM orders WHERE id=$1", [o.id]))
      .payment_status,
    "paid",
  );
});
