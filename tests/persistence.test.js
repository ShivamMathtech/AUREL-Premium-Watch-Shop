import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDatabase, initializeDatabase } from "../server/db.js";
test("SQLite catalog edits survive a database close and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aurel-db-test-"));
  let db;
  try {
    const path = join(dir, "store.sqlite");
    db = await connectDatabase({ path, url: "" });
    await initializeDatabase(db, {});
    await db.run("UPDATE products SET stock=7,price=1234500 WHERE id=$1", [
      "verde-automatic",
    ]);
    await db.close();
    db = await connectDatabase({ path, url: "" });
    await initializeDatabase(db, {});
    const row = await db.get("SELECT stock,price FROM products WHERE id=$1", [
      "verde-automatic",
    ]);
    assert.equal(row.stock, 7);
    assert.equal(row.price, 1234500);
  } finally {
    if (db) await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
