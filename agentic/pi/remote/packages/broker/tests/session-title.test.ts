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
import type { StreamEvent } from "../../protocol/src/index.ts";

test("generated titles and later renames notify every connected app while idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-title-"));
  const nativeId = randomUUID();
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: nativeId }) + "\n");
  const config = ConfigSchema.parse({
    origin: "https://fixture.test.ts.net",
    dataDir: root,
    home: root,
  });
  const store = new Store(root);
  const emitted: StreamEvent[] = [];
  const connections = new Connections(config, store, (event) => emitted.push(event));
  await connections.listen();
  const socket = net.connect(path.join(root, "broker.sock"));
  socket.setEncoding("utf8");
  let buffer = "";
  const received: { type: string }[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const wait = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Title fixture did not receive the expected IPC event");
  };
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  try {
    send({ secret: connections.secret });
    await wait(() => received.some((event) => event.type === "ready"));
    send({
      type: "register",
      data: {
        version: 1,
        instanceId: randomUUID(),
        sessionId: nativeId,
        sessionFile: file,
        cwd: root,
        name: "Untitled",
        pid: process.pid,
        managed: false,
        model: "fixture/model",
        thinking: "off",
        capabilities: [],
        idle: true,
        loop: false,
      },
    });
    await wait(() => received.some((event) => event.type === "registered"));
    const id = store.sessions()[0]!.sessionId;
    for (const name of ["Generated conversation title", "A different topic", "Local rename"]) {
      emitted.length = 0;
      send({ type: "event", kind: "session_info_changed", data: { name } });
      await wait(() => emitted.some((event) => event.type === "session_info_changed"));
      assert.equal(store.session(id)!.name, name);
      assert.equal(store.session(id)!.state, "idle");
      const changed = emitted.find((event) => event.type === "sessions.changed");
      assert(changed, "Title changes must invalidate app metadata without a later agent event");
      assert.equal((changed.data as { name: string }).name, name);
    }
    for (const data of [{ name: "Local rename" }, {}]) {
      emitted.length = 0;
      send({ type: "event", kind: "session_info_changed", data });
      await wait(() => emitted.some((event) => event.type === "session_info_changed"));
      assert.equal(store.session(id)!.name, "Local rename");
      assert(!emitted.some((event) => event.type === "sessions.changed"));
    }
  } finally {
    socket.destroy();
    await connections.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
