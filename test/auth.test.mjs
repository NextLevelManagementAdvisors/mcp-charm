import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression test for the auth gate on the HTTP transport.
// Guards the fix from #17: a tokenless request must be rejected with a
// WWW-Authenticate: Bearer challenge (so MCP clients prompt for credentials
// instead of misfiring OAuth dynamic client registration).
const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "dist", "index.js");
const TOKEN = "test-token-abc123";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitReady(base, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become ready in time");
}

let child;
let base;

before(async () => {
  const port = await freePort();
  base = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, [ENTRY, "http"], {
    env: Object.assign({}, process.env, {
      MCP_TRANSPORT: "http",
      PORT: String(port),
      MCP_AUTH_TOKEN: TOKEN,
    }),
    stdio: "ignore",
  });
  await waitReady(base);
});

after(() => {
  if (child) child.kill("SIGKILL");
});

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "regression-test", version: "0" },
  },
});
const INIT_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

test("tokenless POST /mcp returns 401 with WWW-Authenticate: Bearer", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  const wa = res.headers.get("www-authenticate") || "";
  assert.match(wa, /Bearer/i);
});

test("valid token via ?token= is accepted (not 401)", async () => {
  const res = await fetch(base + "/mcp?token=" + TOKEN, {
    method: "POST",
    headers: INIT_HEADERS,
    body: INIT_BODY,
  });
  assert.notEqual(res.status, 401);
});

test("valid token via Authorization Bearer is accepted (not 401)", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: Object.assign({ authorization: "Bearer " + TOKEN }, INIT_HEADERS),
    body: INIT_BODY,
  });
  assert.notEqual(res.status, 401);
});
