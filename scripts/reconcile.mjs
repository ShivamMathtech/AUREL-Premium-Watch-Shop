import Stripe from "stripe";
import { getDatabase } from "../server/db.js";
import { settleStripeEvent } from "../server/orders.js";
if (!process.env.STRIPE_SECRET_KEY)
  throw new Error("Set STRIPE_SECRET_KEY first.");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 10000 });
const db = await getDatabase();
if (!db) throw new Error("Configure a database first.");
try {
  const rows = await db.all(
    "SELECT * FROM orders WHERE payment_method='stripe' AND status='awaiting_payment' ORDER BY created_at LIMIT 500",
  );
  for (const row of rows) {
    if (!row.stripe_session) {
      console.log(
        row.id +
          ": no session linked; customer can retry the same checkout key. Review in Stripe before any manual stock adjustment.",
      );
      continue;
    }
    const session = await stripe.checkout.sessions.retrieve(row.stripe_session);
    if (session.status === "expired")
      await settleStripeEvent(db, {
        type: "checkout.session.expired",
        data: { object: session },
      });
    else if (session.payment_status === "paid")
      await settleStripeEvent(db, {
        type: "checkout.session.completed",
        data: { object: session },
      });
    console.log(
      row.id + ": " + session.status + " / " + session.payment_status,
    );
  }
} finally {
  await db.close();
}
