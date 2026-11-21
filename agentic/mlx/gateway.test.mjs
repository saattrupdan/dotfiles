import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createGateway, MODEL_ID } from "./gateway.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function setup(t, { flags = [], ...options } = {}) {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const backendPort = probe.address().port;
  await new Promise((done) => probe.close(done));
  const gateway = createGateway({
    port: 0, backendPort, modelPath: "/fake/model", idleMs: 80, startupMs: 2000,
    stopMs: 100, log: () => {},
    workerCommand: [process.execPath, fixture, "--port", String(backendPort), "--model", "/fake/model", ...flags],
    ...options,
  });
  const port = await gateway.start();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${port}`;
  return { base, backendPort, gateway, health: async () => (await fetch(`${base}/health`)).json() };
}

function infer(base, extra = {}, options = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: "user", content: "Hi" }], ...extra }),
    ...options,
  });
}

async function until(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("Condition timed out");
}

test("discovery and invalid requests never start a worker", async (t) => {
  const { base, health } = await setup(t);
  assert.equal((await (await fetch(`${base}/v1/models`)).json()).data[0].id, MODEL_ID);
  assert.equal((await infer(base, { model: "arbitrary-model" })).status, 400);
  assert.equal((await fetch(`${base}/unload`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 415);
  for (const extra of [{ messages: [null] }, { messages: [{}] }, { messages: [] }, { messages: [{ role: "user", content: 42 }] }, { max_tokens: -1 }, { temperature: "hot" }, { tools: [null] }]) {
    assert.equal((await infer(base, extra)).status, 400);
  }
  assert.equal((await health()).worker, "stopped");
});

test("concurrent cold requests share startup and idle expiry ignores discovery", async (t) => {
  const { base, health } = await setup(t, { flags: ["--ready-delay", "120"] });
  const replies = await Promise.all([infer(base), infer(base), infer(base)]);
  const bodies = await Promise.all(replies.map((reply) => reply.json()));
  assert.equal(new Set(bodies.map((body) => body.pid)).size, 1);
  assert.equal((await health()).worker, "ready");
  await until(async () => (await health()).worker === "stopped");
  const next = await (await infer(base)).json();
  assert.notEqual(next.pid, bodies[0].pid);
});

test("image, tool definitions, tool results and sampling fields survive rewriting", async (t) => {
  const { base } = await setup(t);
  const body = {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }, { role: "tool", tool_call_id: "t1", content: "result" }],
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    reasoning_effort: "low", temperature: 0, max_tokens: 256,
  };
  const received = await (await infer(base, body)).json();
  assert.deepEqual(received.body, { model: "/fake/model", ...body });
});

test("streams outlive idle timeout and preserve SSE bytes", async (t) => {
  const { base, health } = await setup(t, { idleMs: 35 });
  const response = await infer(base, { stream: true });
  assert.equal(response.headers.get("x-fixture"), "stream");
  const text = await response.text();
  assert.equal((text.match(/data: /g) ?? []).length, 9);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  await until(async () => (await health()).worker === "stopped");
});

test("one completed request cannot stop another active request", async (t) => {
  const { base } = await setup(t, { idleMs: 30 });
  const replies = await Promise.all([infer(base), infer(base, { test_delay: 220 })]);
  const data = await Promise.all(replies.map((reply) => reply.json()));
  assert.equal(data[0].pid, data[1].pid);
});

test("client cancellation during startup does not strand a worker", async (t) => {
  const { base, health } = await setup(t, { idleMs: 30, flags: ["--ready-delay", "300"] });
  const controller = new AbortController();
  const pending = infer(base, {}, { signal: controller.signal });
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  await until(async () => (await health()).worker === "starting");
  controller.abort();
  await cancelled;
  await until(async () => (await health()).worker === "stopped");
});

test("cancelling one startup waiter preserves another", async (t) => {
  const { base, health } = await setup(t, { idleMs: 30, flags: ["--ready-delay", "180"] });
  const controller = new AbortController();
  const cancelled = assert.rejects(infer(base, {}, { signal: controller.signal }), { name: "AbortError" });
  const surviving = infer(base);
  await until(async () => (await health()).active === 2);
  controller.abort();
  await cancelled;
  assert.ok((await (await surviving).json()).pid);
});

test("midstream cancellation releases the worker after idle", async (t) => {
  const { base, health } = await setup(t, { idleMs: 35 });
  const response = await infer(base, { stream: true, test_chunks: 100 });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await until(async () => (await health()).worker === "stopped");
});

test("new inference waits for TERM-to-KILL stop then starts a fresh worker", async (t) => {
  const { base, health } = await setup(t, { idleMs: 30, flags: ["--ignore-term"], stopMs: 100 });
  const first = await (await infer(base)).json();
  await until(async () => (await health()).worker === "stopping");
  const next = await (await infer(base)).json();
  assert.notEqual(first.pid, next.pid);
});

test("new arrival recovers from a cancelled startup already stopping", async (t) => {
  const { base, health } = await setup(t, { idleMs: 30, flags: ["--ignore-term", "--ready-delay", "250"], stopMs: 130 });
  const controller = new AbortController();
  const cancelled = assert.rejects(infer(base, {}, { signal: controller.signal }), { name: "AbortError" });
  await until(async () => (await health()).worker === "starting");
  await sleep(60);
  controller.abort();
  await cancelled;
  await until(async () => (await health()).worker === "stopping");
  const response = await infer(base);
  assert.equal(response.status, 200);
  await response.json();
});

test("upstream errors and crashes are surfaced without replay", async (t) => {
  const { base, health } = await setup(t);
  const busy = await infer(base, { test_action: "error" });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "3");
  assert.deepEqual(await busy.json(), { error: "busy" });
  const crashed = await infer(base, { test_action: "crash" });
  assert.equal(crashed.status, 502);
  await crashed.json();
  await until(async () => (await health()).worker === "stopped");
  await (await infer(base)).json();
});

test("failed preload and startup timeout fail clearly and reap children", async (t) => {
  for (const options of [{ flags: ["--preload-fail"] }, { flags: ["--ready-delay", "1000"], startupMs: 80 }, { flags: ["--crash"] }]) {
    const { base, health } = await setup(t, options);
    const response = await infer(base);
    assert.equal(response.status, 503);
    await response.json();
    await until(async () => (await health()).worker === "stopped");
  }
});

test("shutdown reaps a worker and does not adopt an unrelated listener", async (t) => {
  const { base, gateway, backendPort } = await setup(t);
  await (await infer(base)).json();
  await gateway.close();
  const listener = net.createServer();
  listener.listen(backendPort, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((done) => listener.close(done)));
  const other = await setup(t, { backendPort });
  const response = await infer(other.base);
  assert.equal(response.status, 503);
  await response.json();
  assert.ok(listener.listening);
});

test("one failed connection cannot kill another live inference", async (t) => {
  const { base, health } = await setup(t, { idleMs: 40 });
  const first = await (await infer(base)).json();
  const active = infer(base, { test_delay: 250 });
  await until(async () => (await health()).active === 1);
  const failed = await infer(base, { test_action: "disconnect" });
  assert.equal(failed.status, 502);
  await failed.json();
  const next = await (await infer(base)).json();
  assert.equal(next.pid, first.pid);
  assert.equal((await (await active).json()).pid, first.pid);
});

test("CLI reuses its own gateway without starting a worker", async (t) => {
  const { base, health } = await setup(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./gateway.mjs", import.meta.url)), "--port", new URL(base).port], { stdio: "ignore" });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal((await health()).worker, "stopped");
});

test("CLI refuses an unrelated frontend service", async (t) => {
  const listener = http.createServer((_request, response) => response.end('{"status":"healthy"}'));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((done) => listener.close(done)));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./gateway.mjs", import.meta.url)), "--port", String(listener.address().port)], { stdio: "ignore" });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.ok(listener.listening);
});

test("CLI leaves llama.cpp port arguments after the separator untouched", async () => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./gateway.mjs", import.meta.url)), "--", process.execPath,
    fileURLToPath(new URL("./fixtures/fake-peer.mjs", import.meta.url)), "--port", "8080",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), ["--port", "8080"]);
});
