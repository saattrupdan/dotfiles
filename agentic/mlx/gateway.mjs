import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODEL_ID = "mlx-inkling-2-mini";
// Open Pi sessions retain their selected ID after a registry rename.
const INFERENCE_MODEL_IDS = new Set([MODEL_ID, "inkling-2-mini-heretic"]);

/** Own one lazy worker; discovery never loads model weights. */
export function createGateway({
  port = 8084,
  backendPort = 18084,
  modelPath = resolve(homedir(), "local-models/.cache/inkling-mlx-heretic-4bit"),
  draftPath = resolve(homedir(), "local-models/.cache/inkling-mlx-regular"),
  python = resolve(homedir(), "local-models/.cache/inkling-mlx-env/bin/python"),
  workerCommand,
  idleMs = 60_000,
  startupMs = 180_000,
  stopMs = 10_000,
  log = console.error,
} = {}) {
  let worker;
  let starting;
  let stopping;
  let idleTimer;
  let active = 0;
  let closed = false;
  const sockets = new Set();
  const backend = `http://127.0.0.1:${backendPort}`;
  const command = workerCommand ?? [python, "-m", "mlx_vlm.server",
    "--host", "127.0.0.1", "--port", String(backendPort), "--model", modelPath,
    "--draft-model", draftPath, "--draft-kind", "dflash", "--draft-block-size", "4",
    "--prefill-step-size", "256", "--max-num-seqs", "1"];

  async function stopWorker() {
    if (stopping) return stopping;
    const owned = worker;
    if (!owned) return;
    clearTimeout(idleTimer);
    stopping = (async () => {
      log("MLX: stopping worker");
      signalGroup(owned.child, "SIGTERM");
      const killTimer = setTimeout(() => signalGroup(owned.child, "SIGKILL"), stopMs);
      try { await owned.exited; }
      finally {
        clearTimeout(killTimer);
        if (worker === owned) worker = undefined;
      }
    })();
    try { await stopping; }
    finally { stopping = undefined; }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!closed && active === 0 && worker) {
      idleTimer = setTimeout(() => {
        if (active === 0) void stopWorker();
      }, idleMs);
    }
  }

  async function ensureWorker() {
    if (stopping) {
      await stopping;
      await starting?.catch(() => {});
    }
    if (closed) throw new Error("Gateway is shutting down");
    if (starting) return starting;
    if (worker?.ready && worker.child.exitCode === null && worker.child.signalCode === null) return;
    if (worker) {
      await stopWorker();
      return ensureWorker();
    }
    starting = (async () => {
      await assertPortFree(backendPort);
      if (closed) throw new Error("Gateway is shutting down");
      log("MLX: starting worker on demand");
      const child = spawn(command[0], command.slice(1), {
        stdio: ["ignore", "inherit", "inherit"], detached: true,
      });
      let failure;
      const owned = { child, ready: false, alive: true };
      owned.exited = new Promise((done) => {
        child.once("error", (error) => { failure = error; });
        child.once("close", () => {
          owned.alive = false;
          if (worker === owned) worker = undefined;
          done();
        });
      });
      worker = owned;
      if (active === 0) scheduleIdle();
      const deadline = Date.now() + startupMs;
      try {
        while (Date.now() < deadline && !closed && !stopping && owned.alive && worker === owned) {
          if (failure) throw failure;
          try {
            const response = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(1000) });
            const health = await response.json();
            if (Object.keys(health.preload_failures ?? {}).length) {
              throw new Error("MLX model preload failed");
            }
            if (response.ok && health.model_ready === true && health.loaded_model === modelPath) {
              owned.ready = true;
              log("MLX: worker ready");
              return;
            }
          } catch (error) {
            if (error.message === "MLX model preload failed") throw error;
          }
          await new Promise((done) => setTimeout(done, 50));
        }
        throw failure ?? new Error("MLX worker exited or timed out before readiness");
      } catch (error) {
        if (worker === owned) await stopWorker();
        throw error;
      }
    })();
    try { await starting; }
    finally { starting = undefined; }
  }

  const server = http.createServer(async (request, response) => {
    if (closed) return reply(response, 503, "Gateway is shutting down");
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "healthy", service: "inkling-mlx-gateway-v1", model: MODEL_ID, worker: stopping ? "stopping" : worker?.ready ? "ready" : starting ? "starting" : "stopped", active });
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "local" }] });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      return reply(response, 404, "Unknown endpoint");
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return reply(response, 415, "Content-Type must be application/json");
    }
    let body;
    try {
      body = await readJson(request);
      validateRequest(body);
    } catch (error) {
      return reply(response, error.status ?? 400, error.message);
    }
    if (response.destroyed) return;
    active += 1;
    clearTimeout(idleTimer);
    let upstream;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      upstream?.destroy();
      active -= 1;
      scheduleIdle();
    };
    response.once("close", finish);
    response.once("finish", finish);
    try {
      await ensureWorker();
      if (finished || response.destroyed) return;
      const payload = Buffer.from(JSON.stringify({ ...body, model: modelPath }));
      const headers = cleanHeaders(request.headers);
      headers["content-length"] = String(payload.length);
      upstream = http.request(`${backend}/v1/chat/completions`, {
        method: "POST", headers, agent: false,
      }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, cleanHeaders(incoming.headers));
        incoming.once("error", (error) => response.destroy(error));
        incoming.pipe(response);
      });
      upstream.once("error", (error) => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy(error);
        else reply(response, 502, "MLX upstream request failed");
      });
      upstream.end(payload);
    } catch (error) {
      if (!response.destroyed) reply(response, 503, error.message);
    }
  });
  server.requestTimeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    async start() {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    },
    async close() {
      closed = true;
      clearTimeout(idleTimer);
      const done = server.listening ? new Promise((resolveClose) => server.close(resolveClose)) : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      // Startup may be checking port ownership before it has created the child.
      await stopWorker();
      await starting?.catch(() => {});
      await stopWorker();
      await done;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const gatewayArgs = separator >= 0 ? args.slice(0, separator) : args;
  const pythonIndex = gatewayArgs.indexOf("--python");
  const portIndex = gatewayArgs.indexOf("--port");
  const port = portIndex >= 0 ? Number(gatewayArgs[portIndex + 1]) : 8084;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid gateway port");
  const gateway = createGateway({ port, ...(pythonIndex >= 0 ? { python: gatewayArgs[pythonIndex + 1] } : {}) });
  try { await gateway.start(); }
  catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (!response.ok || health.service !== "inkling-mlx-gateway-v1" || health.model !== MODEL_ID) {
      throw new Error(`Port ${port} belongs to another service`);
    }
    console.error("MLX: reusing the existing lightweight gateway");
  }
  console.error(`MLX gateway: http://127.0.0.1:${port}/v1 (worker starts on request; idle stop 60s)`);
  let llama;
  let closing;
  const close = () => closing ??= (async () => {
    if (llama && llama.exitCode === null && llama.signalCode === null) {
      llama.kill("SIGTERM");
      const timer = setTimeout(() => llama.kill("SIGKILL"), 10_000);
      await once(llama, "close").catch(() => {});
      clearTimeout(timer);
    }
    await gateway.close();
  })();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void close());
  if (separator >= 0) {
    const command = args.slice(separator + 1);
    llama = spawn(command[0], command.slice(1), { stdio: "inherit" });
    llama.once("error", (error) => { console.error(error.message); process.exitCode = 1; void close(); });
    llama.once("exit", (code) => { process.exitCode = code ?? 0; void close(); });
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function assertPortFree(port) {
  const probe = net.createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((done) => probe.close(done));
}

function validateRequest(body) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.length > 0;
  const fail = () => { throw new Error("Invalid chat-completion request"); };
  const validCall = (call) => object(call) && text(call.id) && call.type === "function" &&
    object(call.function) && text(call.function.name) && typeof call.function.arguments === "string";
  const validPart = (part) => object(part) && (
    (part.type === "text" && typeof part.text === "string") ||
    (part.type === "image_url" && object(part.image_url) && text(part.image_url.url) &&
      /^(https?:\/\/|data:image\/)/.test(part.image_url.url))
  );
  if (!object(body)) fail();
  if (!INFERENCE_MODEL_IDS.has(body.model)) throw new Error(`Unknown model; use '${MODEL_ID}'`);
  if (!Array.isArray(body.messages) || !body.messages.length) fail();
  for (const message of body.messages) {
    if (!object(message) || !["system", "user", "assistant", "tool"].includes(message.role)) fail();
    const calls = message.tool_calls;
    if (calls !== undefined && (!Array.isArray(calls) || !calls.every(validCall))) fail();
    const content = message.content;
    const hasContent = typeof content === "string" || (Array.isArray(content) && content.length > 0 && content.every(validPart));
    const hasAssistantState = message.role === "assistant" && (calls?.length > 0 || text(message.reasoning_content));
    if (!hasContent && !hasAssistantState) fail();
    if (message.role === "tool" && !text(message.tool_call_id)) fail();
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") fail();
  for (const name of ["max_tokens", "max_completion_tokens"]) {
    if (body[name] != null && (!Number.isSafeInteger(body[name]) || body[name] < 1 || body[name] > 32768)) fail();
  }
  for (const [name, min, max] of [["temperature", 0, 2], ["top_p", 0, 1], ["min_p", 0, 1]]) {
    if (body[name] != null && (!Number.isFinite(body[name]) || body[name] < min || body[name] > max)) fail();
  }
  if (body.top_k != null && (!Number.isSafeInteger(body.top_k) || body.top_k < 0)) fail();
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every((tool) =>
    object(tool) && tool.type === "function" && object(tool.function) && text(tool.function.name) &&
    (tool.function.parameters === undefined || object(tool.function.parameters))))) fail();
}

function cleanHeaders(headers) {
  const blocked = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
  for (const name of String(headers.connection ?? "").split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw Object.assign(new Error("Request exceeds 64 MiB"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response, status, message) {
  if (response.headersSent || response.destroyed) return;
  json(response, status, { error: { message, type: "gateway_error" } });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
