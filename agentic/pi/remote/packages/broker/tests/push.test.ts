import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import webpush from "web-push";
import { createBroker } from "../src/server.ts";
import { ConfigSchema } from "../src/config.ts";
import { digest } from "../src/store.ts";
import type { Session } from "../../protocol/src/index.ts";

test("background, locked and stale clients receive completion, failure and input push", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-push-")),
    origin = "https://fixture.test.ts.net";
  const broker = await createBroker(
    ConfigSchema.parse({
      origin,
      dataDir: root,
      home: root,
      agentDir: fileURLToPath(new URL("../../../../", import.meta.url)),
    }),
    { ipc: false, history: false },
  );
  const id = randomUUID(),
    device = randomUUID(),
    now = Date.now(),
    sent: Record<string, unknown>[] = [];
  const session = {
    version: 1,
    instanceId: randomUUID(),
    sessionId: id,
    sessionFile: path.join(root, "session.jsonl"),
    cwd: root,
    name: "Private session",
    pid: process.pid,
    managed: false,
    model: "fixture",
    thinking: "off",
    capabilities: [],
    idle: true,
    loop: false,
    epoch: 1,
    sequence: 0,
    state: "idle",
    lastActivity: now,
  } as Session;
  broker.store.save(session);
  broker.store.db
    .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
    .run(device, "Phone", "{}", now);
  broker.store.db
    .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
    .run(digest("cookie"), device, "csrf", now, now, null, now + 86400000, 1);
  const key = `push:${device}:fixture`;
  broker.store.set(
    key,
    JSON.stringify({
      endpoint: "https://web.push.apple.com/fixture",
      keys: { auth: "fixture", p256dh: "fixture" },
    }),
  );
  let expired = false;
  t.mock.method(
    webpush,
    "sendNotification",
    async (_subscription: unknown, payload: string) => {
      if (expired) throw { statusCode: 410 };
      sent.push(JSON.parse(payload));
      return { statusCode: 201, body: "", headers: {} };
    },
  );
  let socket: WebSocket | undefined;
  const tick = async () => {
    for (let i = 0; i < 10; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const emit = (type: string, data: unknown) =>
    broker.connections.emit({ version: 1, sessionId: id, type, data });
  try {
    const address = await broker.app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/events", {
      headers: {
        host: new URL(origin).host,
        origin,
        cookie: "__Host-pi-remote=cookie",
      },
    });
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ subscriptions: [{ sessionId: id, sequence: 0 }] }));
    await ready;
    emit("agent_settled", { outcome: "finished" });
    await tick();
    assert.equal(sent.length, 0);
    broker.store.db.prepare("UPDATE auth SET background=?").run(now);
    emit("agent_settled", { outcome: "finished" });
    await tick();
    assert.equal(sent.at(-1)?.body, "A run finished.");
    assert.equal(sent.at(-1)?.title, "Private session");
    assert.equal(sent.at(-1)?.url, `/session/${id}`);
    broker.store.db.prepare("UPDATE auth SET background=NULL,seen=?").run(now - 46000);
    emit("agent_settled", { outcome: "failed" });
    await tick();
    assert.equal(sent.at(-1)?.body, "A run failed.");
    broker.store.db.prepare("UPDATE auth SET unlocked=0").run();
    emit("prompt", { title: "Private question must not leave broker" });
    await tick();
    assert.equal(sent.at(-1)?.body, "Pi needs your attention.");
    assert.doesNotMatch(JSON.stringify(sent), /Private question must not leave broker/);
    broker.store.save({
      ...session,
      name: "   Named\nconversation " + "x".repeat(200),
    });
    emit("agent_settled", { outcome: "finished" });
    await tick();
    assert.equal((sent.at(-1)?.title as string).length, 160);
    assert.match(sent.at(-1)?.title as string, /^Named conversation /);
    broker.store.save({ ...session, name: "  " });
    emit("agent_settled", { outcome: "finished" });
    await tick();
    assert.equal(sent.at(-1)?.title, "Pi Remote");
    expired = true;
    emit("agent_settled", { outcome: "finished" });
    await tick();
    assert.equal(broker.store.setting(key), undefined);
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await broker.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
