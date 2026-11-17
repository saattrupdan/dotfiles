import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBroker } from "../src/server.ts";
import { ConfigSchema } from "../src/config.ts";
import { Store, digest } from "../src/store.ts";
import type { Session } from "../../protocol/src/index.ts";

test("completion acknowledgement is authenticated, durable and fenced to the observed result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-"));
  const origin = "https://fixture.test.ts.net";
  const broker = await createBroker(
    ConfigSchema.parse({ origin, dataDir: root, home: root }),
    { ipc: false, history: false },
  );
  const id = randomUUID(),
    device = randomUUID(),
    now = Date.now();
  const headers = {
    host: new URL(origin).host,
    origin,
    cookie: "__Host-pi-remote=cookie",
    "x-pi-csrf": "csrf",
  };
  const session: Session = {
    version: 1,
    instanceId: randomUUID(),
    sessionId: id,
    sessionFile: path.join(root, "session.jsonl"),
    cwd: root,
    name: "Completion fixture",
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
    completion: { id: randomUUID(), outcome: "finished" },
  };
  broker.store.save(session);
  broker.store.db
    .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
    .run(device, "Phone", "{}", now);
  broker.store.db
    .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
    .run(digest("cookie"), device, "csrf", now, now, null, now + 86400000, 1);
  const ack = (completionId: string, customHeaders = headers) =>
    broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${id}/acknowledge`,
      headers: customHeaders,
      payload: { completionId },
    });
  try {
    const first = session.completion!;
    const read = await broker.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${id}`,
      headers,
    });
    assert.equal(read.json().completion.id, first.id);
    assert.equal(
      broker.store.session(id)!.completion?.id,
      first.id,
      "reading is not acknowledgement",
    );
    assert.equal((await ack(first.id, { ...headers, cookie: "" })).statusCode, 401);
    assert.equal(
      (await ack(first.id, { ...headers, "x-pi-csrf": "wrong" })).statusCode,
      403,
    );
    assert.equal(broker.store.session(id)!.completion?.id, first.id);
    const newer = {
      ...session,
      completion: { id: randomUUID(), outcome: "finished" as const },
    };
    broker.store.save(newer);
    const stale = await ack(first.id);
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.json().completion.id, newer.completion.id);
    const cleared = await ack(newer.completion.id);
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().completion, undefined);
    assert.equal(broker.store.session(id)!.idle, true);
    assert.equal(broker.store.session(id)!.sequence, 1);
    await ack(newer.completion.id);
    assert.equal(
      broker.store.session(id)!.sequence,
      1,
      "duplicate entry is idempotent",
    );
    const reopened = new Store(root);
    try {
      assert.equal(reopened.session(id)!.completion, undefined);
    } finally {
      reopened.close();
    }
    const failed = {
      ...session,
      completion: { id: randomUUID(), outcome: "failed" as const },
    };
    broker.store.save(failed);
    await ack(failed.completion.id);
    assert.equal(broker.store.session(id)!.completion?.outcome, "failed");
    broker.store.hideSession(id);
    assert.equal((await ack(failed.completion.id)).statusCode, 404);
  } finally {
    await broker.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
