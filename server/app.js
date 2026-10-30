import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import Stripe from "stripe";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDatabase, productFromRow, orderFromRow } from "./db.js";
import {
  HttpError,
  digest,
  hashPassword,
  verifyPassword,
  publicUser,
  createSession,
  cookieOptions,
  requireUser,
  requireAdmin,
  rateLimit,
} from "./security.js";
import { createOrder, changeOrderStatus, settleStripeEvent } from "./orders.js";

const email = z.string().trim().toLowerCase().email().max(254);
const productSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    collection: z.enum(["Automatic", "Dress", "Chronograph", "Dive"]),
    price: z.number().int().min(100).max(100000000),
    stock: z.number().int().min(0).max(100000),
    image: z
      .string()
      .max(600)
      .refine(
        (s) =>
          /^\/images\/[a-z0-9-]+\.(png|jpg|webp)$/.test(s) ||
          /^https:\/\//.test(s),
        "Use a local image path or HTTPS image URL.",
      ),
    description: z.string().trim().min(10).max(1500),
    color: z.string().max(50),
    strap: z.string().max(80),
    movement: z.string().max(80),
    size: z.string().max(30),
    water: z.string().max(30),
    reserve: z.string().max(50),
    badge: z.string().max(40),
    featured: z.boolean(),
    active: z.boolean().default(true),
  })
  .strict();
const uniqueError = (e) =>
  e.code === "23505" ||
  (e.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(e.message));

export function createApp({ database, stripeClient } = {}) {
  const app = express();
  const dbProvider = database ? () => Promise.resolve(database) : getDatabase;
  const stripe = () =>
    stripeClient ||
    (process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY, {
          maxNetworkRetries: 1,
          timeout: 10000,
        })
      : null);
  const paymentsEnabled = () =>
    !!(
      stripeClient ||
      (process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_WEBHOOK_SECRET &&
        process.env.APP_URL)
    );
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Webhook must receive the exact raw bytes, before JSON middleware.
  app.post(
    "/api/payments/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res, next) => {
      try {
        if (!paymentsEnabled())
          throw new HttpError(503, "Card payments are not configured.");
        let event;
        try {
          event = stripe().webhooks.constructEvent(
            req.body,
            req.headers["stripe-signature"],
            process.env.STRIPE_WEBHOOK_SECRET,
          );
        } catch {
          throw new HttpError(400, "Invalid webhook signature.");
        }
        const db = await dbProvider();
        if (!db) throw new HttpError(503, "Database is not configured.");
        await settleStripeEvent(db, event);
        res.json({ received: true });
      } catch (e) {
        next(e);
      }
    },
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    const appOrigin = process.env.APP_URL?.replace(/\/$/, "");
    let matchesHost = false;
    try {
      matchesHost = new URL(origin).host === req.get("host");
    } catch {}
    if (
      (origin && origin !== appOrigin && !matchesHost) ||
      req.get("sec-fetch-site") === "cross-site"
    )
      return next(new HttpError(403, "Cross-site requests are not permitted."));
    if (
      req.get("x-aurel-client") !== "storefront" ||
      !req.is("application/json")
    )
      return next(
        new HttpError(403, "A same-origin JSON request is required."),
      );
    next();
  });
  app.get("/api/health", async (req, res, next) => {
    try {
      const db = await dbProvider();
      if (db) await db.get("SELECT 1 AS ok");
      res.json({
        mode: db ? "live" : "demo",
        payments: { cod: true, stripe: !!db && paymentsEnabled() },
      });
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", async (req, res, next) => {
    try {
      req.db = await dbProvider();
      if (!req.db)
        throw new HttpError(
          503,
          "This deployment runs in demo mode. Configure DATABASE_URL for live orders.",
        );
      const token = req.cookies.aurel_session;
      if (token && /^[a-f0-9]{64}$/.test(token))
        req.user = await req.db.get(
          "SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2",
          [digest(token), Date.now()],
        );
      next();
    } catch (e) {
      next(e);
    }
  });
  const ip = (req) =>
    process.env.VERCEL
      ? req.get("x-vercel-forwarded-for") || req.socket.remoteAddress
      : req.socket.remoteAddress;
  const throttle = async (req, suffix, max = 20) =>
    rateLimit(req.db, `${suffix}:${ip(req)}`, max);

  app.get("/api/products", async (req, res) =>
    res.json(
      (
        await req.db.all("SELECT * FROM products WHERE active=1 ORDER BY id")
      ).map(productFromRow),
    ),
  );
  app.get("/api/auth/me", (req, res) =>
    res.json({ user: req.user ? publicUser(req.user) : null }),
  );
  app.post("/api/auth/register", async (req, res) => {
    await throttle(req, "register", 10);
    const data = z
      .object({
        name: z.string().trim().min(2).max(80),
        email,
        password: z.string().min(12).max(128),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    const hashed = await hashPassword(data.password);
    try {
      await req.db.run(
        "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [id, data.name, data.email, hashed, "customer", Date.now()],
      );
    } catch (e) {
      if (uniqueError(e))
        throw new HttpError(409, "An account with this email already exists.");
      throw e;
    }
    await createSession(req.db, id, res);
    res
      .status(201)
      .json({
        user: { id, name: data.name, email: data.email, role: "customer" },
      });
  });
  app.post("/api/auth/login", async (req, res) => {
    await throttle(req, "login", 30);
    const data = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    await rateLimit(req.db, "account:" + data.email, 30);
    const user = await req.db.get("SELECT * FROM users WHERE email=$1", [
      data.email,
    ]);
    const valid = await verifyPassword(
      data.password,
      user?.password_hash ||
        "00000000000000000000000000000000:" + "00".repeat(64),
    );
    if (!user || !valid)
      throw new HttpError(401, "Email or password is incorrect.");
    await createSession(req.db, user.id, res);
    res.json({ user: publicUser(user) });
  });
  app.post("/api/auth/logout", async (req, res) => {
    if (req.cookies.aurel_session)
      await req.db.run("DELETE FROM sessions WHERE token_hash=$1", [
        digest(req.cookies.aurel_session),
      ]);
    res.clearCookie("aurel_session", { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });
  app.get("/api/wishlist", requireUser, async (req, res) =>
    res.json(
      (
        await req.db.all("SELECT product_id FROM wishlist WHERE user_id=$1", [
          req.user.id,
        ])
      ).map((r) => r.product_id),
    ),
  );
  app.put("/api/wishlist", requireUser, async (req, res) => {
    const ids = z.array(z.string().max(80)).max(100).parse(req.body.ids);
    await req.db.transaction(async (tx) => {
      await tx.run("DELETE FROM wishlist WHERE user_id=$1", [req.user.id]);
      for (const id of new Set(ids))
        if (await tx.get("SELECT id FROM products WHERE id=$1", [id]))
          await tx.run(
            "INSERT INTO wishlist(user_id,product_id) VALUES($1,$2)",
            [req.user.id, id],
          );
    });
    res.json({ ok: true });
  });
  app.post("/api/newsletter", async (req, res) => {
    await throttle(req, "newsletter", 10);
    const input = z.object({ email, consent: z.literal(true) }).parse(req.body);
    await req.db.run(
      "INSERT INTO subscribers(email,created_at) VALUES($1,$2) ON CONFLICT(email) DO NOTHING",
      [input.email, Date.now()],
    );
    res.json({ ok: true });
  });
  app.get("/api/orders", requireUser, async (req, res) =>
    res.json(
      (
        await req.db.all(
          "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
          [req.user.id],
        )
      ).map(orderFromRow),
    ),
  );
  app.get("/api/orders/:id", requireUser, async (req, res) => {
    const row = await req.db.get(
      "SELECT * FROM orders WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    if (!row) throw new HttpError(404, "Order not found.");
    res.json(orderFromRow(row));
  });
  app.post("/api/orders", requireUser, async (req, res) => {
    await throttle(req, "order", 50);
    if (req.body.paymentMethod === "stripe" && !paymentsEnabled())
      throw new HttpError(
        400,
        "Card payments are not configured. Choose cash on delivery.",
      );
    const order = await createOrder(
      req.db,
      req.user,
      req.body,
      req.get("idempotency-key"),
    );
    if (order.paymentMethod !== "stripe" || order.paymentStatus === "paid")
      return res.status(201).json(order);
    if (order.status === "cancelled")
      throw new HttpError(
        409,
        "This payment session expired. Start a new checkout from your bag.",
      );
    const row = await req.db.get("SELECT * FROM orders WHERE id=$1", [
      order.id,
    ]);
    const payment = stripe();
    let session;
    try {
      if (row.stripe_session)
        session = await payment.checkout.sessions.retrieve(row.stripe_session);
      else {
        session = await payment.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            customer_email: req.user.email,
            client_reference_id: order.id,
            metadata: { orderId: order.id },
            line_items: [
              {
                price_data: {
                  currency: "inr",
                  unit_amount: order.total,
                  product_data: {
                    name: `AUREL order ${order.id}`,
                    description: order.items
                      .map((i) => `${i.name} × ${i.quantity}`)
                      .join(", ")
                      .slice(0, 200),
                  },
                },
                quantity: 1,
              },
            ],
            success_url: `${process.env.APP_URL}/orders/${order.id}?payment=return`,
            cancel_url: `${process.env.APP_URL}/orders/${order.id}?payment=cancelled`,
          },
          { idempotencyKey: "aurel-" + order.id },
        );
        await req.db.run("UPDATE orders SET stripe_session=$1 WHERE id=$2", [
          session.id,
          order.id,
        ]);
      }
    } catch {
      throw new HttpError(
        502,
        "Payment provider is unavailable. Your order is reserved; retry this checkout with the same details.",
      );
    }
    if (!session.url)
      throw new HttpError(
        409,
        "This payment session has closed. Check your order history for its status.",
      );
    res.status(201).json({ ...order, checkoutUrl: session.url });
  });
  app.post("/api/orders/:id/resume", requireUser, async (req, res) => {
    const row = await req.db.get(
      "SELECT * FROM orders WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    if (!row || !row.stripe_session || row.status !== "awaiting_payment")
      throw new HttpError(409, "No open payment session is available.");
    const session = await stripe().checkout.sessions.retrieve(
      row.stripe_session,
    );
    if (!session.url)
      throw new HttpError(
        409,
        "Payment session has closed. Refresh your order status.",
      );
    res.json({ url: session.url });
  });

  app.use("/api/admin", requireUser, requireAdmin);
  app.get("/api/admin/summary", async (req, res) => {
    const orders = (
      await req.db.all(
        "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500",
      )
    ).map(orderFromRow);
    const stats = await req.db.get(
      "SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN payment_status='paid' THEN total ELSE 0 END),0) AS revenue FROM orders",
    );
    const customers = await req.db.get(
      "SELECT COUNT(*) AS count FROM users WHERE role='customer'",
    );
    const allProducts = (
      await req.db.all("SELECT * FROM products ORDER BY id")
    ).map(productFromRow);
    res.json({
      orders,
      products: allProducts,
      stats: {
        orders: Number(stats.orders),
        revenue: Number(stats.revenue),
        customers: Number(customers.count),
        lowStock: allProducts.filter((p) => p.stock < 5 && p.active).length,
      },
      audit: await req.db.all(
        "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30",
      ),
    });
  });
  app.post("/api/admin/products", async (req, res) => {
    const data = productSchema.parse(req.body);
    const id =
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 55) +
      "-" +
      randomUUID().slice(0, 6);
    await req.db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO products(id,data,price,stock,active) VALUES($1,$2,$3,$4,$5)",
        [id, JSON.stringify(data), data.price, data.stock, +data.active],
      );
      await tx.run(
        "INSERT INTO audit_logs(id,actor_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), req.user.id, "product:create", id, Date.now()],
      );
    });
    res.status(201).json({ ...data, id });
  });
  app.put("/api/admin/products/:id", async (req, res) => {
    const data = productSchema.parse(req.body);
    const expectedStock = z.coerce
      .number()
      .int()
      .min(0)
      .safeParse(req.get("if-stock"));
    if (!expectedStock.success)
      throw new HttpError(
        400,
        "Stock version is required. Reload the product.",
      );
    await req.db.transaction(async (tx) => {
      const updated = await tx.run(
        "UPDATE products SET data=$1,price=$2,stock=$3,active=$4 WHERE id=$5 AND stock=$6",
        [
          JSON.stringify(data),
          data.price,
          data.stock,
          +data.active,
          req.params.id,
          expectedStock.data,
        ],
      );
      if (!updated.changes)
        throw new HttpError(
          409,
          "Stock changed or product was removed. Reload before saving.",
        );
      await tx.run(
        "INSERT INTO audit_logs(id,actor_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          req.user.id,
          "product:update",
          req.params.id,
          Date.now(),
        ],
      );
    });
    res.json({ ...data, id: req.params.id });
  });
  app.patch("/api/admin/orders/:id", async (req, res) => {
    const { status } = z
      .object({
        status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
      })
      .strict()
      .parse(req.body);
    res.json(
      await changeOrderStatus(req.db, req.params.id, status, req.user.id),
    );
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  if (existsSync(resolve("dist/index.html"))) {
    app.use(express.static(resolve("dist")));
    app.get("/{*path}", (req, res) => res.sendFile(resolve("dist/index.html")));
  }
  app.use((err, req, res, next) => {
    const status = err instanceof z.ZodError ? 400 : err.status || 500;
    if (status >= 500)
      console.error("Request failed:", err.name, err.code || "INTERNAL_ERROR");
    const message =
      err instanceof z.ZodError
        ? `${err.issues[0].path.join(".")}: ${err.issues[0].message}`
        : status >= 500
          ? "The store is temporarily unavailable. Please retry."
          : err.message;
    res.status(status).json({ error: message });
  });
  return app;
}
