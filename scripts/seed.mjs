import { getDatabase } from "../server/db.js";
const db = await getDatabase();
if (!db) throw new Error("Configure DATABASE_URL first.");
console.log(
  "Schema and sample catalog initialized; existing products were preserved.",
);
await db.close();
