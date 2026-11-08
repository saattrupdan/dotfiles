import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  withOwnedTransition,
  type OwnershipState,
} from "../../../../extensions/_session_ownership/transition.ts";
import {
  acquire,
  newOwner,
  inspect,
  reserveNamespace,
  releaseNamespace,
} from "../../../../extensions/_session_ownership/ownership.mjs";
import { Owners } from "../src/ipc.ts";
import { Store } from "../src/store.ts";
import { ConfigSchema } from "../src/config.ts";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-owner-test-"));
  const a = path.join(root, "a.jsonl"),
    b = path.join(root, "b.jsonl");
  for (const file of [a, b])
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", id: randomUUID() }) + "\n",
    );
  const owner = newOwner();
  const lock = path.join(root, "ownership");
  acquire(a, owner, lock);
  const context = {
    sessionManager: {
      getSessionFile: () => a,
      getSessionId: () => JSON.parse(fs.readFileSync(a, "utf8")).id,
    },
  } as unknown as NonNullable<OwnershipState["context"]>;
  const state: OwnershipState = {
    owner,
    root: lock,
    files: new Set([a]),
    current: a,
    context,
  };
  return { root, a, b, state, owner, lock };
}
const globalState = globalThis as typeof globalThis & {
  __piSessionOwnership?: OwnershipState;
};
test("cancelled and invalid transitions release reservations while retaining the source", async () => {
  const f = fixture();
  globalState.__piSessionOwnership = f.state;
  try {
    await withOwnedTransition(async () => {
      acquire(f.b, f.owner, f.lock);
      f.state.files.add(f.b);
      return { cancelled: true };
    });
    assert.equal(inspect(f.b, f.lock), undefined);
    assert(inspect(f.a, f.lock));
    await assert.rejects(
      withOwnedTransition(async () => {
        acquire(f.b, f.owner, f.lock);
        f.state.files.add(f.b);
        throw new Error("invalid fork entry");
      }),
      /invalid fork/,
    );
    assert.equal(inspect(f.b, f.lock), undefined);
    const other = newOwner();
    reserveNamespace(other, f.lock);
    releaseNamespace(other, f.lock);
    assert.throws(() => acquire(f.a, other, f.lock), /owned by/);
  } finally {
    delete globalState.__piSessionOwnership;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("successful replacement releases source only after fresh context; failed teardown retains locks", async () => {
  const f = fixture();
  globalState.__piSessionOwnership = f.state;
  try {
    await withOwnedTransition(async () => {
      f.state.transition!.shutdown = true;
      f.state.transition!.started = true;
      f.state.context = {
        sessionManager: {
          getSessionFile: () => f.b,
          getSessionId: () => JSON.parse(fs.readFileSync(f.b, "utf8")).id,
        },
      } as unknown as NonNullable<OwnershipState["context"]>;
    });
    assert.equal(inspect(f.a, f.lock), undefined);
    assert(inspect(f.b, f.lock));
    await assert.rejects(
      withOwnedTransition(async () => {
        f.state.transition!.shutdown = true;
        throw new Error("runtime load failed");
      }),
      /runtime load/,
    );
    assert.throws(() => reserveNamespace(newOwner(), f.lock), /owned by/);
  } finally {
    delete globalState.__piSessionOwnership;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("owner unregister preserves monotonic epochs and replay cursors", async () => {
  const f = fixture();
  const config = ConfigSchema.parse({
    origin: "https://fixture.test.ts.net",
    dataDir: f.root,
    home: f.root,
  });
  const store = new Store(f.root);
  const owners = new Owners(config, store, () => {});
  await owners.listen();
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
    send({ secret: owners.secret });
    await wait("ready");
    const sessionId = JSON.parse(fs.readFileSync(f.a, "utf8")).id;
    const registration = {
      version: 1,
      ...f.owner,
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
    await owners.close();
    store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
