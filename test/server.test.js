import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../src/app.js";

let server, base;
const hasSoffice = (() => { try { execFileSync("which", [process.env.SOFFICE_PATH || "soffice"]); return true; } catch { return false; } })();

before(async () => {
  await new Promise((r) => { server = createApp({ apiKey: "secret", maxMb: 1, maxUploads: 2, rateLimiter: null }).listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const post = (name, content, headers = { "x-api-key": "secret" }) => {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  return fetch(`${base}/convert`, { method: "POST", body: form, headers });
};

test("health", async () => assert.equal((await fetch(`${base}/health`)).status, 200));
test("rejects missing/wrong API key", async () => {
  assert.equal((await post("a.txt", "hi", {})).status, 401);
  assert.equal((await post("a.txt", "hi", { "x-api-key": "nope" })).status, 401);
});
test("400 without file", async () => {
  const r = await fetch(`${base}/convert`, { method: "POST", body: new FormData(), headers: { "x-api-key": "secret" } });
  assert.equal(r.status, 400);
});
test("415 for unsupported extension", async () => assert.equal((await post("a.exe", "hi")).status, 415));
test("415 when content does not match extension", async () => assert.equal((await post("fake.docx", "not a zip")).status, 415));
test("413 when too large", async () => assert.equal((await post("big.txt", "a".repeat(2 * 1024 * 1024))).status, 413));

test("converts txt to a real PDF", { skip: !hasSoffice && "soffice not installed" }, async () => {
  const r = await post("note.txt", "Hello PDF");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});

test("timeout kills the whole process group", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-"));
  const marker = `fake-soffice-child-${process.pid}`;
  const script = path.join(dir, "soffice");
  // Mimics the soffice wrapper: spawns a long-running child, then waits.
  await writeFile(script, `#!/bin/sh\nexec -a ${marker} sleep 300 &\nwait\n`);
  await chmod(script, 0o755);
  process.env.SOFFICE_PATH = script;
  process.env.CONVERT_TIMEOUT_MS = "500";
  try {
    assert.equal((await post("t.txt", "hi")).status, 504);
    await new Promise((r) => setTimeout(r, 300));
    let alive = "";
    try { alive = execFileSync("pgrep", ["-f", marker]).toString().trim(); } catch {}
    assert.equal(alive, "", "child process should be dead");
  } finally {
    delete process.env.SOFFICE_PATH; delete process.env.CONVERT_TIMEOUT_MS;
  }
});

test("server refuses to start without an API key", () => {
  for (const bad of [undefined, "", "   "]) {
    assert.throws(() => createApp({ apiKey: bad, rateLimiter: null }), /API_KEY/);
  }
});

test("503 with Retry-After when too many uploads are running", async () => {
  const app = createApp({ apiKey: "secret", maxUploads: 1, rateLimiter: null });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://localhost:${srv.address().port}/convert`;
  try {
    // Hold the only slot open with an upload that never finishes.
    const hold = http.request(url, { method: "POST", headers: { "x-api-key": "secret", "content-type": "multipart/form-data; boundary=x", "content-length": "1000" } });
    hold.on("error", () => {});
    hold.write("--x\r\n");
    await new Promise((r) => setTimeout(r, 200));
    const form = new FormData();
    form.append("file", new Blob(["hi"]), "a.txt");
    const r = await fetch(url, { method: "POST", body: form, headers: { "x-api-key": "secret" } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    hold.destroy();
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("503 when the total size of files in progress is over the budget", async () => {
  const app = createApp({ apiKey: "secret", maxMb: 3, maxUploads: 10, maxUploadMb: 5, rateLimiter: null });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://localhost:${srv.address().port}/convert`;
  try {
    const mb3 = 3 * 1024 * 1024;
    const hold = http.request(url, { method: "POST", headers: { "x-api-key": "secret", "content-type": "multipart/form-data; boundary=x", "content-length": String(mb3) } });
    hold.on("error", () => {});
    hold.write("--x\r\n");
    await new Promise((r) => setTimeout(r, 200));
    const send = (bytes) => { const f = new FormData(); f.append("file", new Blob([Buffer.alloc(bytes, 97)]), "a.txt"); return fetch(url, { method: "POST", body: f, headers: { "x-api-key": "secret" } }); };
    assert.equal((await send(mb3 - 1000)).status, 503, "3 MB + 3 MB is over the 5 MB budget");
    assert.notEqual((await send(1000)).status, 503, "a small file still fits");
    hold.destroy();
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("the real server program exits before listening when API_KEY is empty or blank", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const bad of ["", "   "]) {
    const r = spawnSync(process.execPath, ["src/server.js"], {
      env: { PATH: process.env.PATH, API_KEY: bad, RATE_LIMIT_DISABLED: "true", PORT: "0" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(r.status, 1, `exit code for API_KEY="${bad}"`);
    assert.match(r.stderr, /API_KEY/);
    assert.doesNotMatch(r.stdout, /listening/);
  }
});

test("wrong API key gets 401 before the file is read", async () => {
  // Big file + wrong key: the answer must be 401, not 413, which proves the upload step never ran.
  assert.equal((await post("big.txt", "a".repeat(2 * 1024 * 1024), { "x-api-key": "nope" })).status, 401);
  assert.equal((await post("big.txt", "a".repeat(2 * 1024 * 1024), {})).status, 401);
});
