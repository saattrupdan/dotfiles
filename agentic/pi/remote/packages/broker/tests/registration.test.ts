import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Connections } from "../src/ipc.ts";
import { Store } from "../src/store.ts";
import { Envelope, NativeEnvelope } from "../../protocol/src/index.ts";
import { sessionReference } from "../src/session-reference.ts";
import { ConfigSchema } from "../src/config.ts";
for (const nativeId of [randomUUID(), "nvim-native-session-fixture"])
  test(`authenticated session unregister preserves epochs and cursors (${nativeId.startsWith("nvim-") ? "native ID" : "UUID"})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-registration-"));
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "session", id: nativeId }) + "\n");
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
      let sessionId = nativeId;
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
      sessionId = store.sessions()[0]!.sessionId;
      assert.match(sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(sessionId, sessionReference(file, nativeId));
      assert.equal(
        store.session(sessionId)!.nativeSessionId,
        sessionId === nativeId ? undefined : nativeId,
      );
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
      const phase = async (kind: string, data: unknown, label: string | undefined) => {
        send({ type: "event", kind, data });
        for (let i = 0; i < 100; i++) {
          if (connections.workingMessage(store.session(sessionId)!) === label) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(connections.workingMessage(store.session(sessionId)!), label);
      };
      assert.equal(connections.workingMessage(store.session(sessionId)!), "Working...");
      await phase(
        "message_update",
        { role: "assistant", content: [{ type: "thinking", thinking: "fixture" }] },
        "Thinking...",
      );
      await phase(
        "tool_execution_start",
        { toolCallId: "b", name: "bash" },
        "Bashing...",
      );
      await phase(
        "tool_execution_start",
        { toolCallId: "m", name: "store_memory" },
        "Storing to memory…",
      );
      await phase("tool_execution_end", { toolCallId: "m" }, "Bashing...");
      await phase(
        "working_override",
        { label: "Preparing worktree..." },
        "Preparing worktree...",
      );
      await phase("working_override", {}, "Bashing...");
      await phase("agent_settled", null, undefined);
      await phase("agent_start", null, "Working...");
      store.event(sessionId, "agent_settled", null);
      const cursor = store.session(sessionId)!.sequence;
      send({ type: "unregister" });
      send({ type: "register", data: registration });
      assert.equal((await wait("registered")).epoch, 2);
      assert.equal(store.session(sessionId)!.sequence, cursor);
      const envelope = Envelope.parse({
        version: 1,
        commandId: randomUUID(),
        sessionId,
        epoch: 2,
        command: { action: "message", text: "Native fixture", images: [] },
      });
      store.journal(envelope, "fixture");
      if (nativeId !== sessionId) {
        assert.equal(
          Envelope.safeParse({ ...envelope, sessionId: nativeId }).success,
          false,
        );
        assert.throws(
          () => connections.send(store.session(sessionId)!, envelope),
          /native_session_reload_required/,
        );
        assert.equal(store.command(envelope.commandId)!.status, "received");
        assert(!queue.some((v) => v.type === "command"));
        send({ type: "register", data: { ...registration, nativeSessionEnvelope: 1 } });
        assert.equal((await wait("registered")).epoch, 2);
      }
      connections.send(store.session(sessionId)!, envelope);
      const nativeEnvelope = NativeEnvelope.parse((await wait("command")).envelope);
      assert.equal(nativeEnvelope.sessionId, nativeId);
      assert.equal(nativeEnvelope.commandId, envelope.commandId);
      assert.equal(nativeEnvelope.epoch, envelope.epoch);
      send({ type: "ack", commandId: envelope.commandId, status: "persisted" });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(store.command(envelope.commandId)!.status, "persisted");
      assert.equal(store.command(envelope.commandId)!.session, sessionId);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).id, nativeId);
    } finally {
      socket.destroy();
      await connections.close();
      store.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

test("private native sessions are removed rather than retained as visible saved tombstones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-private-registration-"));
  const store = new Store(root);
  const config = ConfigSchema.parse({
    origin: "https://fixture.test.ts.net",
    dataDir: root,
    home: root,
  });
  const emitted: { type: string; sessionId?: string }[] = [];
  const connections = new Connections(config, store, (event) => emitted.push(event));
  await connections.listen();
  const socket = net.connect(path.join(root, "broker.sock"));
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
      const at = queue.findIndex((row) => row.type === type);
      if (at >= 0) return queue.splice(at, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${type}`);
  };
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  try {
    const nativeId = randomUUID();
    const file = path.join(root, "private.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", id: nativeId, cwd: root }) + "\n",
    );
    send({ secret: connections.secret });
    await wait("ready");
    send({
      type: "register",
      data: {
        version: 1,
        instanceId: randomUUID(),
        sessionId: nativeId,
        sessionFile: file,
        cwd: root,
        name: "Private fixture",
        pid: process.pid,
        managed: false,
        model: "fixture/model",
        thinking: "off",
        capabilities: [],
        idle: true,
        loop: false,
      },
    });
    await wait("registered");
    store.event(nativeId, "message_end", {
      role: "assistant",
      content: "private fixture",
    });
    send({ type: "private", sessionId: nativeId });
    for (
      let i = 0;
      i < 100 && !emitted.some((event) => event.type === "session.hidden");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      store.session(nativeId),
      undefined,
      "incognito must not remain discoverable as a stopped saved row",
    );
    assert(
      emitted.some(
        (event) => event.type === "session.hidden" && event.sessionId === nativeId,
      ),
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM events WHERE session=?")
        .get(nativeId)!.n,
      0,
    );
    assert(fs.existsSync(file), "hiding from phone must not delete local history");
    const catalogNative = "nvim-private-catalog-only",
      publicId = randomUUID();
    store.rememberReferences([{ nativeId: catalogNative, id: publicId }]);
    send({ type: "private", sessionId: catalogNative });
    for (
      let i = 0;
      i < 100 &&
      !emitted.some(
        (event) => event.type === "session.hidden" && event.sessionId === publicId,
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(
      emitted.some(
        (event) => event.type === "session.hidden" && event.sessionId === publicId,
      ),
      "catalog-only public reference must invalidate connected phone caches",
    );
    assert(store.hiddenSessions().includes(publicId));
  } finally {
    socket.destroy();
    await connections.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
