import { randomUUID } from "node:crypto";
import { getDatabase } from "../server/db.js";
import { hashPassword } from "../server/security.js";
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (
  !ADMIN_EMAIL?.includes("@") ||
  !ADMIN_PASSWORD ||
  ADMIN_PASSWORD.length < 12
)
  throw new Error(
    "Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 12 characters in .env.",
  );
const db = await getDatabase();
if (!db) throw new Error("Database is required.");
const hash = await hashPassword(ADMIN_PASSWORD);
await db.transaction(async (tx) => {
  await tx.run(
    "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO UPDATE SET password_hash=$4,role=$5",
    [
      randomUUID(),
      "Store administrator",
      ADMIN_EMAIL.toLowerCase().trim(),
      hash,
      "admin",
      Date.now(),
    ],
  );
  const u = await tx.get("SELECT id FROM users WHERE email=$1", [
    ADMIN_EMAIL.toLowerCase().trim(),
  ]);
  await tx.run("DELETE FROM sessions WHERE user_id=$1", [u.id]);
});
console.log("Admin account updated; previous sessions revoked.");
await db.close();
