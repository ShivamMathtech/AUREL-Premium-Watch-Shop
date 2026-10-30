import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { products } from "../shared/catalog.js";
import { hashPassword } from "./security.js";

export async function connectDatabase({
  url = process.env.DATABASE_URL,
  path = process.env.SQLITE_PATH || "./data/aurel.sqlite",
} = {}) {
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    const wrap = (client) => ({
      kind: "postgres",
      lock: " FOR UPDATE",
      all: async (sql, p = []) => (await client.query(sql, p)).rows,
      get: async (sql, p = []) => (await client.query(sql, p)).rows[0],
      run: async (sql, p = []) => ({
        changes: (await client.query(sql, p)).rowCount,
      }),
    });
    return {
      ...wrap(pool),
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const out = await fn(wrap(c));
          await c.query("COMMIT");
          return out;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  const stmt = (sql, p) => {
    const args = [];
    const query = sql.replace(/\$(\d+)/g, (_, n) => {
      args.push(p[Number(n) - 1]);
      return "?";
    });
    return [db.prepare(query), args];
  };
  const raw = {
    kind: "sqlite",
    lock: "",
    all: async (sql, p = []) => {
      const [s, a] = stmt(sql, p);
      return s.all(...a);
    },
    get: async (sql, p = []) => {
      const [s, a] = stmt(sql, p);
      return s.get(...a);
    },
    run: async (sql, p = []) => {
      const [s, a] = stmt(sql, p);
      return s.run(...a);
    },
  };
  // Serialize all access, including reads, so another request never enters a transaction.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  return {
    kind: "sqlite",
    lock: "",
    all: (...a) => serial(() => raw.all(...a)),
    get: (...a) => serial(() => raw.get(...a)),
    run: (...a) => serial(() => raw.run(...a)),
    transaction: (fn) =>
      serial(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const out = await fn(raw);
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }),
    close: () => serial(() => db.close()),
  };
}

export const schema = [
  "CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','admin')), created_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=100), stock INTEGER NOT NULL CHECK(stock>=0), active INTEGER NOT NULL DEFAULT 1)",
  "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL, stripe_session TEXT, created_at BIGINT NOT NULL, UNIQUE(user_id,idempotency_key))",
  "CREATE TABLE IF NOT EXISTS wishlist (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id), PRIMARY KEY(user_id,product_id))",
  "CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, created_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, created_at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS orders_user_date ON orders(user_id,created_at)",
  "CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)",
];

export async function initializeDatabase(
  db,
  {
    adminEmail = process.env.ADMIN_EMAIL,
    adminPassword = process.env.ADMIN_PASSWORD,
  } = {},
) {
  const { randomUUID } = await import("node:crypto");
  if (
    adminPassword &&
    (adminPassword.length < 12 || !adminEmail?.includes("@"))
  )
    throw new Error(
      "Admin configuration requires an email and a password of at least 12 characters.",
    );
  const pass = adminPassword ? await hashPassword(adminPassword) : null;
  await db.transaction(async (tx) => {
    if (tx.kind === "postgres")
      await tx.get("SELECT pg_advisory_xact_lock(58425197)");
    for (const sql of schema) await tx.run(sql);
    for (const p of products)
      await tx.run(
        "INSERT INTO products(id,data,price,stock) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
        [p.id, JSON.stringify(p), p.price, p.stock],
      );
    if (pass)
      await tx.run(
        "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO NOTHING",
        [
          randomUUID(),
          "Store administrator",
          adminEmail.toLowerCase().trim(),
          pass,
          "admin",
          Date.now(),
        ],
      );
    await tx.run(
      "INSERT INTO schema_versions(version,applied_at) VALUES(1,$1) ON CONFLICT(version) DO NOTHING",
      [Date.now()],
    );
  });
  return db;
}

let pending;
export function getDatabase() {
  if (process.env.VERCEL && !process.env.DATABASE_URL)
    return Promise.resolve(null);
  if (!pending)
    pending = connectDatabase()
      .then((db) => initializeDatabase(db))
      .catch((e) => {
        pending = null;
        throw e;
      });
  return pending;
}
export const productFromRow = (r) => ({
  ...JSON.parse(r.data),
  id: r.id,
  price: r.price,
  stock: r.stock,
  active: !!r.active,
});
export const orderFromRow = (r) => ({
  ...JSON.parse(r.data),
  id: r.id,
  total: r.total,
  status: r.status,
  paymentMethod: r.payment_method,
  paymentStatus: r.payment_status,
  createdAt: Number(r.created_at),
});
