import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createResilientFetcher,
  fetchDirResilient,
  HttpStatusError,
} from "../dist/resilient-fetch.js";

// Regression tests for #26: during an upstream outage, fetch() had no
// timeout/signal, network errors triggered a full ancestor walk (multiplying
// the same timeout N times), and the real error cause (e.g.
// UND_ERR_CONNECT_TIMEOUT) was swallowed by String(err).

const ORIGINS = ["https://mirror-a.example", "https://mirror-b.example", "https://mirror-c.example"];

function networkError(code) {
  const err = new TypeError("fetch failed");
  err.cause = { code };
  return err;
}

test("fetchUrl passes an abort signal (request timeout) to fetch", async () => {
  let seenSignal;
  const fetchImpl = async (_url, opts) => {
    seenSignal = opts.signal;
    return { ok: true, text: async () => "<html></html>" };
  };
  const { fetchUrl } = createResilientFetcher(ORIGINS, "test-ua", { fetchImpl });
  await fetchUrl(ORIGINS[0] + "/Ford/");
  assert.ok(seenSignal instanceof AbortSignal, "fetch must be called with an AbortSignal");
});

test("fetchUrl surfaces the underlying cause code instead of a bare TypeError", async () => {
  const fetchImpl = async () => {
    throw networkError("UND_ERR_CONNECT_TIMEOUT");
  };
  const { fetchUrl } = createResilientFetcher(ORIGINS, "test-ua", { fetchImpl });
  await assert.rejects(() => fetchUrl(ORIGINS[0] + "/Ford/"), (err) => {
    assert.match(err.message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.doesNotMatch(err.message, /^TypeError: fetch failed$/);
    return true;
  });
});

test("fetchUrl does not fail over to another mirror on a 404 (mirrors serve identical content)", async () => {
  const calledOrigins = [];
  const fetchImpl = async (url) => {
    calledOrigins.push(new URL(url).origin);
    return { ok: false, status: 404 };
  };
  const { fetchUrl } = createResilientFetcher(ORIGINS, "test-ua", { fetchImpl });
  await assert.rejects(() => fetchUrl(ORIGINS[0] + "/Ford/Nope/"), HttpStatusError);
  assert.deepEqual(calledOrigins, [ORIGINS[0]], "only the requested origin should be tried on 404");
});

test("fetchUrl fails over to the next mirror on a network error, then circuit-breaks the dead one", async () => {
  let now = 0;
  const calls = [];
  const fetchImpl = async (url) => {
    const origin = new URL(url).origin;
    calls.push(origin);
    if (origin === ORIGINS[0]) throw networkError("UND_ERR_CONNECT_TIMEOUT");
    return { ok: true, text: async () => "<html>ok</html>" };
  };
  const { fetchUrl } = createResilientFetcher(ORIGINS, "test-ua", {
    fetchImpl,
    now: () => now,
    circuitBreakerMs: 60_000,
  });

  const first = await fetchUrl(ORIGINS[0] + "/Ford/");
  assert.equal(first.finalUrl, ORIGINS[1] + "/Ford/");
  assert.deepEqual(calls, [ORIGINS[0], ORIGINS[1]]);

  calls.length = 0;
  now = 1_000; // still within the 60s breaker window
  const second = await fetchUrl(ORIGINS[0] + "/Ford/2018/");
  assert.equal(second.finalUrl, ORIGINS[1] + "/Ford/2018/");
  assert.deepEqual(calls, [ORIGINS[1]], "dead mirror should be skipped while breaker is open");

  calls.length = 0;
  now = 61_000; // breaker window elapsed
  await fetchUrl(ORIGINS[0] + "/Ford/2019/");
  assert.deepEqual(calls, [ORIGINS[0], ORIGINS[1]], "mirror should be retried once the breaker resets");
});

test("fetchUrl fails over to the next mirror on a 502, then circuit-breaks the dead one", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const origin = new URL(url).origin;
    calls.push(origin);
    if (origin === ORIGINS[0]) return { ok: false, status: 502 };
    return { ok: true, text: async () => "<html>ok</html>" };
  };
  const { fetchUrl, isDead } = createResilientFetcher(ORIGINS, "test-ua", { fetchImpl });

  const result = await fetchUrl(ORIGINS[0] + "/Ford/");
  assert.equal(result.finalUrl, ORIGINS[1] + "/Ford/");
  assert.deepEqual(calls, [ORIGINS[0], ORIGINS[1]]);
  assert.ok(isDead(ORIGINS[0]), "mirror that returned 502 should be circuit-broken");
});

test("fetchDirResilient walks up to the nearest ancestor only on a 404", async () => {
  const calledPaths = [];
  const fetchDir = async (path) => {
    calledPaths.push(path);
    if (path === "Ford/2011/E450/Repair/Electrical") throw new HttpStatusError(404, "x");
    if (path === "Ford/2011/E450/Repair") return { html: "<html>ancestor</html>", finalUrl: "https://x/ancestor" };
    throw new Error("unexpected path " + path);
  };
  const segsOf = (p) => p.split("/").filter(Boolean);

  const result = await fetchDirResilient(fetchDir, "Ford/2011/E450/Repair/Electrical", segsOf);
  assert.equal(result.finalUrl, "https://x/ancestor");
  assert.deepEqual(result.fetchedSegs, ["Ford", "2011", "E450", "Repair"]);
  assert.deepEqual(calledPaths, ["Ford/2011/E450/Repair/Electrical", "Ford/2011/E450/Repair"]);
});

test("fetchDirResilient rethrows a network error immediately, without walking ancestors", async () => {
  const calledPaths = [];
  const fetchDir = async (path) => {
    calledPaths.push(path);
    throw networkError("UND_ERR_CONNECT_TIMEOUT");
  };
  const segsOf = (p) => p.split("/").filter(Boolean);

  await assert.rejects(
    () => fetchDirResilient(fetchDir, "Ford/2011/E450/Repair/Electrical", segsOf),
    (err) => {
      assert.equal(err.cause?.code, "UND_ERR_CONNECT_TIMEOUT");
      return true;
    }
  );
  assert.deepEqual(calledPaths, ["Ford/2011/E450/Repair/Electrical"], "must not try any ancestor on a network error");
});

test("fetchDirResilient stops walking ancestors as soon as one fails with a network error", async () => {
  const calledPaths = [];
  const fetchDir = async (path) => {
    calledPaths.push(path);
    if (path === "Ford/2011/E450/Repair/Electrical") throw new HttpStatusError(404, "x");
    if (path === "Ford/2011/E450/Repair") throw networkError("UND_ERR_CONNECT_TIMEOUT");
    throw new Error("unexpected path " + path);
  };
  const segsOf = (p) => p.split("/").filter(Boolean);

  await assert.rejects(
    () => fetchDirResilient(fetchDir, "Ford/2011/E450/Repair/Electrical", segsOf),
    (err) => {
      assert.equal(err.cause?.code, "UND_ERR_CONNECT_TIMEOUT");
      return true;
    }
  );
  assert.deepEqual(calledPaths, ["Ford/2011/E450/Repair/Electrical", "Ford/2011/E450/Repair"]);
});

test("fetchDirResilient rethrows the original 404 if every ancestor also 404s", async () => {
  const fetchDir = async () => {
    throw new HttpStatusError(404, "x");
  };
  const segsOf = (p) => p.split("/").filter(Boolean);

  await assert.rejects(() => fetchDirResilient(fetchDir, "Ford/2011/E450", segsOf), HttpStatusError);
});
