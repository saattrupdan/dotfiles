import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Connections } from "../src/ipc.ts";
import { Store } from "../src/store.ts";
import { ConfigSchema } from "../src/config.ts";
test("authenticated session unregister preserves monotonic epochs and replay cursors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-registration-"));
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: randomUUID() }) + "\n");
  const f = { root, a: file };
  const config = ConfigSchema.parse({
    origin: "https://fixture.test.ts.net",
    dataDir: f.root,
    home: f.root,
  });
  const store = new Store(f.root);
  const connections = new Connections(config, store, () => {});
  await connections.listen();
  const socket = net.connect(path.join(f.root, "broker.sock"));
  socket.setEncoding("utf8");
  let buffer = "";
  const queue: Record<string, unknown>[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let n;
    while ((n = buffer.indexOf("\n")) >= 0) {
      queue.push(JSON.parse(buffer.slice(0, n)));
      buffer = buffer.slice(n + 1);
    }
  });
  const wait = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const at = queue.findIndex((v) => v.type === type);
      if (at >= 0) return queue.splice(at, 1)[0]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Missing ${type}`);
  };
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  try {
    send({ secret: connections.secret });
    await wait("ready");
    const sessionId = JSON.parse(fs.readFileSync(f.a, "utf8")).id;
    const registration = {
      version: 1,
      instanceId: randomUUID(),
      pid: process.pid,
      sessionId,
      sessionFile: f.a,
      cwd: f.root,
      name: "Fixture",
      managed: false,
      model: "fixture/model",
      thinking: "off",
      capabilities: [],
      idle: true,
      loop: false,
    };
    send({ type: "register", data: registration });
    assert.equal((await wait("registered")).epoch, 1);
    const prompt = {
      id: randomUUID(),
      title: "Fixture question",
      deadline: Date.now() - 1,
      state: "expired",
    };
    send({ type: "event", kind: "prompt", data: prompt });
    send({
      type: "event",
      kind: "prompt.expired",
      data: { id: prompt.id, title: prompt.title },
    });
    send({ type: "heartbeat", data: { idle: true, loop: false } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.session(sessionId)!.state, "answer_needed");
    assert.equal(store.session(sessionId)!.prompt?.state, "expired");
    send({ type: "event", kind: "agent_start", data: null });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.session(sessionId)!.state, "running");
    assert.equal(store.session(sessionId)!.prompt, undefined);
    store.event(sessionId, "agent_settled", null);
    const cursor = store.session(sessionId)!.sequence;
    send({ type: "unregister" });
    send({ type: "register", data: registration });
    assert.equal((await wait("registered")).epoch, 2);
    assert.equal(store.session(sessionId)!.sequence, cursor);
  } finally {
    socket.destroy();
    await connections.close();
    store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
