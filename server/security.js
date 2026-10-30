import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return salt + ":" + hash.toString("hex");
}
export async function verifyPassword(password, stored) {
  const [salt, key] = stored.split(":");
  const hash = await scrypt(password, salt, 64);
  const saved = Buffer.from(key, "hex");
  return hash.length === saved.length && timingSafeEqual(hash, saved);
}
export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
});
export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production" || !!process.env.VERCEL,
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 86400000,
});
export async function createSession(db, userId, res) {
  const token = randomBytes(32).toString("hex");
  await db.run("DELETE FROM sessions WHERE expires_at<$1", [Date.now()]);
  await db.run(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [digest(token), userId, Date.now() + 7 * 86400000],
  );
  res.cookie("aurel_session", token, cookieOptions());
}
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const requireUser = (req, res, next) =>
  req.user ? next() : next(new HttpError(401, "Please sign in to continue."));
export const requireAdmin = (req, res, next) =>
  req.user?.role === "admin"
    ? next()
    : next(new HttpError(403, "Administrator access is required."));
export async function rateLimit(db, key, max = 20, windowMs = 15 * 60000) {
  const now = Date.now();
  const count = await db.transaction(async (tx) => {
    await tx.run("DELETE FROM rate_limits WHERE expires_at<$1", [now]);
    const row = await tx.get(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
      [digest(key), now + windowMs],
    );
    return row.count;
  });
  if (count > max)
    throw new HttpError(
      429,
      "Too many attempts. Please try again in 15 minutes.",
    );
}
