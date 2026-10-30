import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("Vercel entrypoint routes health and nested APIs without a database", async (t) => {
  const oldVercel = process.env.VERCEL,
    oldUrl = process.env.DATABASE_URL;
  process.env.VERCEL = "1";
  delete process.env.DATABASE_URL;
  t.after(() => {
    oldVercel === undefined
      ? delete process.env.VERCEL
      : (process.env.VERCEL = oldVercel);
    oldUrl === undefined
      ? delete process.env.DATABASE_URL
      : (process.env.DATABASE_URL = oldUrl);
  });
  const { default: handler } = await import("../api/index.js");
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const res = await fetch(base + "/api?route=health");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mode, "demo");
  const nested = await fetch(base + "/api?route=auth/me");
  assert.equal(nested.status, 503);
  assert.match(nested.headers.get("content-type"), /application\/json/);
});
