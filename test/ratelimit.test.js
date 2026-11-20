import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";
import { createRateLimiter, createRateLimiterFromEnv } from "../src/ratelimit.js";

// A tiny fake Upstash: one shared counter store, like one real Redis used by many servers.
let fake, redisUrl, counters, redisDown = false;
before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (redisDown) return send(500, { error: "down" });
      if (req.headers.authorization !== "Bearer tok") return send(401, { error: "bad token" });
      const cmds = JSON.parse(body);
      if (req.url === "/") return send(200, { result: cmds[0] === "PING" ? "PONG" : null });
      send(200, cmds.map(([c, k]) => {
        if (c === "INCR") { counters.set(k, (counters.get(k) || 0) + 1); return { result: counters.get(k) }; }
        return { result: 1 }; // EXPIRE
      }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  redisUrl = `http://localhost:${fake.address().port}`;
});
after(() => fake.close());

const newApp = async (limits = {}) => {
  const rateLimiter = createRateLimiter({ url: redisUrl, token: "tok", ...limits });
  const app = createApp({ apiKey: "secret", rateLimiter });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { srv, url: `http://localhost:${srv.address().port}/convert` };
};
// "a.exe" is refused with 415 AFTER the limiter, so it shows whether the limiter let the request in.
const send = (url, deviceId, name = "a.exe") => {
  const form = new FormData();
  form.append("file", new Blob(["hi"]), name);
  const headers = { "x-api-key": "secret" };
  if (deviceId) headers["x-device-id"] = deviceId;
  return fetch(url, { method: "POST", body: form, headers });
};
const A = "device-aaaaaaaaaaaaaaaa", B = "device-bbbbbbbbbbbbbbbb";

test("startup: refuses missing or wrong Redis settings", () => {
  assert.throws(() => createRateLimiterFromEnv({}), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => createRateLimiterFromEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }), /UPSTASH_REDIS_REST_TOKEN/);
  assert.throws(() => createRateLimiterFromEnv({ UPSTASH_REDIS_REST_URL: "not a url", UPSTASH_REDIS_REST_TOKEN: "t" }), /valid URL/);
  assert.throws(() => createRateLimiterFromEnv({ UPSTASH_REDIS_REST_URL: "http://example.com", UPSTASH_REDIS_REST_TOKEN: "t" }), /https/);
  assert.equal(createRateLimiterFromEnv({ RATE_LIMIT_DISABLED: "true" }), null);
});

test("startup: ping fails with a wrong token and works with the right one", async () => {
  await assert.rejects(createRateLimiter({ url: redisUrl, token: "wrong" }).ping(), /401/);
  await createRateLimiter({ url: redisUrl, token: "tok" }).ping();
});

test("one caller over quota gets 429 on another instance; another caller still passes", async () => {
  counters = new Map();
  const one = await newApp({ perMinute: 2 }), two = await newApp({ perMinute: 2 });
  try {
    assert.equal((await send(one.url, A)).status, 415); // 1st: let in
    assert.equal((await send(two.url, A)).status, 415); // 2nd: let in (other instance, same counter)
    const r = await send(one.url, A);                   // 3rd: over quota
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await send(two.url, A)).status, 429); // still blocked on the other instance
    assert.equal((await send(two.url, B)).status, 415); // caller B has quota left
  } finally { one.srv.close(); two.srv.close(); }
});

test("daily limit gives 429 with a long Retry-After", async () => {
  counters = new Map();
  const { srv, url } = await newApp({ perMinute: 100, perDay: 1 });
  try {
    assert.equal((await send(url, A)).status, 415);
    const r = await send(url, A);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 60);
  } finally { srv.close(); }
});

test("400 without a valid X-Device-ID, and wrong API key is still 401", async () => {
  const { srv, url } = await newApp();
  try {
    assert.equal((await send(url, undefined)).status, 400);
    assert.equal((await send(url, "short")).status, 400);
    const form = new FormData(); form.append("file", new Blob(["hi"]), "a.txt");
    assert.equal((await fetch(url, { method: "POST", body: form, headers: { "x-api-key": "nope", "x-device-id": A } })).status, 401);
  } finally { srv.close(); }
});

test("503 (not unlimited access) when Redis is down", async () => {
  counters = new Map();
  const { srv, url } = await newApp();
  try {
    redisDown = true;
    const r = await send(url, A);
    assert.equal(r.status, 503);
    assert.ok(r.headers.get("retry-after"));
  } finally { redisDown = false; srv.close(); }
});
