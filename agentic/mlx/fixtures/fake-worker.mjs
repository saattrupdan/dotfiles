import http from "node:http";

const args = process.argv.slice(2);
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const readyAt = Date.now() + Number(value("--ready-delay", "0"));
if (args.includes("--ignore-term")) process.on("SIGTERM", () => {});
if (args.includes("--crash")) process.exit(9);

http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model_ready: Date.now() >= readyAt, loaded_model: value("--model", "/fake/model"), preload_failures: args.includes("--preload-fail") ? { model: "failed" } : {} }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.test_action === "crash") process.exit(8);
  if (body.test_action === "disconnect") { response.destroy(); return; }
  if (body.test_action === "error") {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
    response.end('{"error":"busy"}');
    return;
  }
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream", "x-fixture": "stream" });
    let counter = 0;
    const timer = setInterval(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: String(counter) } }] })}\n\n`);
      if (++counter === (body.test_chunks ?? 8)) {
        clearInterval(timer);
        response.end("data: [DONE]\n\n");
      }
    }, 25);
    response.once("close", () => clearInterval(timer));
    return;
  }
  if (body.test_delay) await new Promise((done) => setTimeout(done, body.test_delay));
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ pid: process.pid, body }));
}).listen(Number(value("--port", "0")), "127.0.0.1");
