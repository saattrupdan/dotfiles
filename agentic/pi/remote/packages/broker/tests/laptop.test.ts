import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import net from "node:net";
import type { Session } from "../../protocol/src/index.ts";
import { ConfigSchema } from "../src/config.ts";
import { History, RECENT_SESSION_MS } from "../src/history.ts";
import { inDeploymentScope } from "../src/deployment-scope.ts";
import { approvePilot, deployment } from "../src/gates.ts";
import { createBroker } from "../src/server.ts";
import { Processes } from "../src/processes.ts";
import { digest } from "../src/store.ts";
import {
  activateLaptop,
  acquire,
  newOwner,
  reserveNamespace,
  releaseNamespace,
} from "../../../../extensions/_session_ownership/ownership.mjs";

function fixture(activated = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-laptop-")));
  const config = ConfigSchema.parse({
    origin: "https://laptop.test.ts.net",
    deploymentPolicy: "pilot",
    pilotScope: "laptop-main",
    home: root,
    agentDir: path.join(root, "agent"),
    dataDir: path.join(root, "data"),
  });
  fs.mkdirSync(path.join(config.agentDir, "sessions/project"), { recursive: true });
  fs.mkdirSync(config.dataDir);
  if (activated) activateLaptop([], path.join(config.dataDir, "ownership"));
  const seed = (directory: string, id = randomUUID(), name?: string) => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}.jsonl`);
    fs.writeFileSync(
      file,
      [
        {
          type: "session",
          version: 3,
          id,
          timestamp: new Date().toISOString(),
          cwd: root,
        },
        {
          type: "message",
          id: "m1",
          parentId: null,
          message: { role: "user", content: "PRIVATE_FIRST_MESSAGE", timestamp: 1 },
        },
        ...(name ? [{ type: "session_info", id: "n1", parentId: "m1", name }] : []),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    return { id, file };
  };
  return {
    root,
    config,
    seed,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function authentication(
  broker: Awaited<ReturnType<typeof createBroker>>,
  origin: string,
) {
  const device = randomUUID(),
    raw = randomUUID(),
    csrf = randomUUID(),
    now = Date.now();
  broker.store.db
    .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
    .run(device, "Fixture", "{}", now);
  broker.store.db
    .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
    .run(digest(raw), device, csrf, now, now, null, now + 86400000, 1);
  return {
    host: new URL(origin).host,
    origin,
    cookie: `__Host-pi-remote=${raw}`,
    "x-pi-csrf": csrf,
  };
}

test("laptop scope includes regular histories and keeps private profiles and escapes out", () => {
  const f = fixture();
  try {
    const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
    assert(inDeploymentScope(f.config, { managed: false, sessionFile: saved.file }));
    assert(
      !inDeploymentScope(
        { ...f.config, pilotScope: "fresh-managed-only" },
        { managed: false, sessionFile: saved.file },
      ),
    );
    const secret = f.seed(path.join(f.config.agentDir, "profile-sessions/librarian"));
    assert(!inDeploymentScope(f.config, { managed: false, sessionFile: secret.file }));
    const alias = path.join(f.config.agentDir, "sessions/project/escape.jsonl");
    fs.symlinkSync(secret.file, alias);
    assert(!inDeploymentScope(f.config, { managed: false, sessionFile: alias }));
  } finally {
    f.close();
  }
});

test("catalog reads only native metadata, deduplicates aliases and keeps duplicate IDs separate", async () => {
  const f = fixture();
  try {
    const a = f.seed(
      path.join(f.config.agentDir, "sessions/project"),
      randomUUID(),
      "Laptop conversation",
    );
    const b = f.seed(path.join(f.config.dataDir, "native-sessions"), a.id, "Copied ID");
    f.seed(
      path.join(f.config.agentDir, "profile-sessions/librarian"),
      randomUUID(),
      "Private profile",
    );
    fs.symlinkSync(a.file, path.join(path.dirname(a.file), "alias.jsonl"));
    const history = new History(f.config);
    const before = fs.readFileSync(a.file);
    const rows = await history.catalog();
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    assert(rows.every((row) => row.nativeId === a.id && row.ambiguous));
    assert(!JSON.stringify(rows).includes("PRIVATE_FIRST_MESSAGE"));
    assert(!("firstMessage" in rows[0]!));
    assert.equal(await history.byId(a.id), undefined);
    assert.equal(
      (await history.byId(rows.find((row) => row.path === b.file)!.id))!.path,
      b.file,
    );
    assert.deepEqual(fs.readFileSync(a.file), before);
  } finally {
    f.close();
  }
});

test("catalog handles large image lines, partial appends, custom roots and renamed metadata", async () => {
  const f = fixture();
  try {
    const directory = path.join(f.root, "custom");
    const saved = f.seed(directory, randomUUID(), "Before");
    f.config.sessionDirectories = [directory];
    fs.appendFileSync(
      saved.file,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "x".repeat(200000) },
      }) + "\n",
    );
    const history = new History(f.config);
    assert.equal((await history.catalog())[0]!.name, "Before");
    const rename = JSON.stringify({ type: "session_info", name: "After" });
    fs.appendFileSync(saved.file, rename.slice(0, -1));
    assert.equal((await history.catalog())[0]!.name, "Before");
    fs.appendFileSync(saved.file, "}\n");
    assert.equal((await history.catalog())[0]!.name, "After");
    const other = f.seed(directory);
    fs.unlinkSync(saved.file);
    fs.symlinkSync(other.file, saved.file);
    assert.equal((await history.catalog()).length, 1);
    await assert.rejects(
      history.messages(saved.file),
      (error: NodeJS.ErrnoException) => error.code === "ELOOP",
    );
  } finally {
    f.close();
  }
});

test("folder discovery is header-only, week-bounded and loads names only for the selected folder", async (t) => {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, "now", () => now);
  try {
    const a = f.seed(
      path.join(f.config.agentDir, "sessions/a"),
      randomUUID(),
      "Folder A",
    );
    const b = f.seed(
      path.join(f.config.agentDir, "sessions/b"),
      randomUUID(),
      "Folder B",
    );
    const old = f.seed(
      path.join(f.config.agentDir, "sessions/old"),
      randomUUID(),
      "Too old",
    );
    const edge = f.seed(
      path.join(f.config.agentDir, "sessions/edge"),
      randomUUID(),
      "Exactly a week",
    );
    for (const [saved, cwd] of [
      [a, "/folder-a"],
      [b, "/folder-b"],
      [old, "/old"],
      [edge, "/edge"],
    ] as const) {
      const lines = fs.readFileSync(saved.file, "utf8").split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cwd });
      fs.writeFileSync(
        saved.file,
        lines.join("\n") +
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "x".repeat(200000) },
          }) +
          "\n",
      );
    }
    fs.utimesSync(
      old.file,
      (now - RECENT_SESSION_MS - 1000) / 1000,
      (now - RECENT_SESSION_MS - 1000) / 1000,
    );
    fs.utimesSync(
      edge.file,
      (now - RECENT_SESSION_MS) / 1000,
      (now - RECENT_SESSION_MS) / 1000,
    );
    const reads: Array<{ inode: number; bytes: number }> = [];
    const original = fs.readSync;
    t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
      const length = original(...args);
      reads.push({ inode: fs.fstatSync(args[0]).ino, bytes: length });
      return length;
    });
    const history = new History(f.config);
    const folders = await history.folders();
    assert.deepEqual(
      new Set(folders.map((folder) => folder.cwd)),
      new Set(["/folder-a", "/folder-b", "/edge"]),
    );
    assert(reads.every((read) => read.bytes <= 8192));
    reads.length = 0;
    assert.equal((await history.catalog("/folder-a"))[0]!.name, "Folder A");
    assert(!reads.some((read) => read.inode === fs.statSync(b.file).ino));
    assert.equal(await history.byId(old.id), undefined);
  } finally {
    f.close();
  }
});

test("large saved conversations use a bounded recent window instead of reading gigabytes", async () => {
  const f = fixture();
  try {
    const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
    const fd = fs.openSync(saved.file, "r+");
    fs.ftruncateSync(fd, 129 * 1024 * 1024);
    fs.closeSync(fd);
    fs.appendFileSync(
      saved.file,
      "\n" +
        JSON.stringify({
          type: "message",
          id: "latest",
          parentId: null,
          message: { role: "user", content: "LATEST_ONLY", timestamp: 2 },
        }) +
        "\n",
    );
    const result = await new History(f.config).messages(saved.file, 0, 100, saved.id);
    assert.equal(result.truncated, true);
    assert(JSON.stringify(result.messages).includes("LATEST_ONLY"));
    assert(!JSON.stringify(result.messages).includes("PRIVATE_FIRST_MESSAGE"));
  } finally {
    f.close();
  }
});

test("native names in the middle of large histories and appended renames are preserved", async () => {
  const f = fixture();
  try {
    const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
    fs.appendFileSync(
      saved.file,
      JSON.stringify({ type: "message", message: { content: "x".repeat(150000) } }) +
        "\n",
    );
    fs.appendFileSync(
      saved.file,
      JSON.stringify({
        id: "named",
        type: "session_info",
        name: "Native session title",
      }) + "\n",
    );
    fs.appendFileSync(
      saved.file,
      JSON.stringify({ type: "message", message: { content: "x".repeat(150000) } }) +
        "\n",
    );
    const history = new History(f.config);
    assert.equal((await history.catalog(f.root))[0]?.name, "Native session title");
    fs.appendFileSync(
      saved.file,
      JSON.stringify({ type: "session_info", name: "Renamed in Pi" }) + "\n",
    );
    assert.equal((await history.catalog(f.root))[0]?.name, "Renamed in Pi");
  } finally {
    f.close();
  }
});

test("agent-working-directory sessions and canonical aliases stay off the phone", async () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, "agent-alias");
    fs.symlinkSync(f.config.agentDir, alias);
    const source = path.join(f.root, "extension-source");
    fs.mkdirSync(source);
    fs.symlinkSync(source, path.join(f.config.agentDir, "extensions"));
    for (const cwd of [
      f.config.agentDir,
      path.join(f.config.agentDir, "extensions"),
      alias,
      path.join(alias, "child"),
      source,
    ]) {
      const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
      const lines = fs.readFileSync(saved.file, "utf8").split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cwd });
      fs.writeFileSync(saved.file, lines.join("\n"));
    }
    assert.deepEqual(await new History(f.config).folders(), []);
    assert.deepEqual(await new History(f.config).catalog(), []);
  } finally {
    f.close();
  }
});

test("simultaneous recovery requests launch the same stopped native history only once", async (t) => {
  const f = fixture();
  const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  let launches = 0,
    release!: (value: Session) => void;
  const pending = new Promise<Session>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    Processes.prototype,
    "launch",
    (cwd: string, native: { id: string; path: string }) => {
      assert.equal(cwd, f.root);
      assert.equal(native.path, saved.file);
      assert.equal(native.id, saved.id);
      launches++;
      return pending;
    },
  );
  try {
    const headers = authentication(broker, f.config.origin);
    const request = () =>
      broker.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${saved.id}/recover`,
        headers,
      });
    const requests = [request(), request()];
    while (!launches) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(launches, 1);
    release(liveSession(saved, f.root));
    const results = await Promise.all(requests);
    assert(results.every((result) => result.statusCode === 200));
    assert.equal(launches, 1);
  } finally {
    release(liveSession(saved, f.root));
    await broker.app.close();
    f.close();
  }
});

test("expanded approval is bound to visibility scope and configured session directories", () => {
  const f = fixture();
  try {
    const evidence = path.join(f.root, "consent.json");
    fs.writeFileSync(evidence, "user-authorized laptop visibility and steering");
    approvePilot({ ...f.config, pilotScope: "fresh-managed-only" }, evidence);
    assert(deployment(f.config).missing.includes("pilot-approval"));
    approvePilot(f.config, evidence);
    assert(!deployment(f.config).missing.includes("pilot-approval"));
    const extra = path.join(f.root, "custom");
    fs.mkdirSync(extra);
    assert(
      deployment({ ...f.config, sessionDirectories: [extra] }).missing.includes(
        "pilot-approval",
      ),
    );
    fs.mkdirSync(path.join(f.config.dataDir, "ownership"), { recursive: true });
    activateLaptop([], path.join(f.config.dataDir, "ownership"));
    assert(!deployment(f.config).missing.includes("pilot-global-ownership-conflict"));
  } finally {
    f.close();
  }
});

test("a missing lease never permits recovery while the recorded process is alive", async () => {
  const f = fixture();
  const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  try {
    const row = liveSession(saved, f.root);
    row.birth = newOwner().birth;
    broker.store.save(row);
    const headers = authentication(broker, f.config.origin);
    const detail = await broker.app.inject({
      url: `/api/v1/sessions/${saved.id}`,
      headers,
    });
    assert.equal(detail.json().recoveryBlockedReason, "owner_not_connected");
    const recover = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/recover`,
      headers,
    });
    assert.equal(recover.statusCode, 409);
    assert.equal(recover.json().error, "owner_still_alive");
    assert(!fs.existsSync(path.join(f.config.dataDir, "launches")));
  } finally {
    await broker.app.close();
    f.close();
  }
});

test("verified registration on B releases A without permitting disconnected-owner takeover", async (t) => {
  const f = fixture();
  const a = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const b = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  const owner = newOwner();
  const first = {
    ...liveSession(a, f.root),
    instanceId: owner.instanceId,
    birth: owner.birth,
    state: "stopped",
  };
  const second = {
    ...liveSession(b, f.root),
    instanceId: owner.instanceId,
    birth: owner.birth,
  };
  const socket = new net.Socket();
  try {
    acquire(b.file, owner, path.join(f.config.dataDir, "ownership"));
    broker.store.save(first);
    broker.store.save(second);
    broker.owners.activeSessions.set(owner.instanceId, b.id);
    broker.owners.sockets.set(owner.instanceId, socket);
    let launches = 0;
    t.mock.method(
      Processes.prototype,
      "launch",
      async (_cwd: string, saved: { path: string }) => {
        assert.equal(saved.path, a.file);
        launches++;
        return first;
      },
    );
    const headers = authentication(broker, f.config.origin);
    assert.equal(
      (await broker.app.inject({ url: `/api/v1/sessions/${a.id}`, headers })).json()
        .recoveryBlockedReason,
      undefined,
    );
    const result = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${a.id}/recover`,
      headers,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(launches, 1);
    broker.owners.sockets.delete(owner.instanceId);
    assert.equal(
      (await broker.app.inject({ url: `/api/v1/sessions/${a.id}`, headers })).json()
        .recoveryBlockedReason,
      "owner_not_connected",
    );
  } finally {
    socket.destroy();
    await broker.app.close();
    f.close();
  }
});

function liveSession(
  saved: { id: string; file: string },
  cwd: string,
  lastActivity = Date.now(),
): Session {
  return {
    version: 1,
    instanceId: randomUUID(),
    sessionId: saved.id,
    sessionFile: saved.file,
    cwd,
    name: "Fixture",
    pid: process.pid,
    birth: "fixture",
    managed: false,
    model: "fixture",
    thinking: "off",
    capabilities: [],
    idle: true,
    loop: false,
    epoch: 1,
    sequence: 0,
    state: "idle",
    lastActivity,
  };
}

test("laptop admission requires activation and migration fences commands before journaling", async (t) => {
  const f = fixture(false);
  const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  const owner = newOwner("migration");
  try {
    const headers = authentication(broker, f.config.origin);
    const recover = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/recover`,
      headers,
    });
    assert.equal(recover.statusCode, 409);
    assert.equal(recover.json().error, "laptop_activation_required");
    assert(!fs.existsSync(path.join(f.config.dataDir, "launches")));
    assert.equal(broker.store.sessions().length, 0);
    activateLaptop([], path.join(f.config.dataDir, "ownership"));
    broker.store.save(liveSession(saved, f.root));
    reserveNamespace(owner, path.join(f.config.dataDir, "ownership"));
    let forwarded = 0;
    t.mock.method(broker.owners, "isConnected", () => true);
    t.mock.method(broker.owners, "send", () => {
      forwarded++;
    });
    const commandId = randomUUID();
    const response = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/messages`,
      headers,
      payload: {
        version: 1,
        sessionId: saved.id,
        epoch: 1,
        commandId,
        command: { action: "message", text: "Must not be forwarded", images: [] },
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "laptop_restart_required");
    assert.equal(forwarded, 0);
    assert.equal(broker.store.command(commandId), undefined);
  } finally {
    releaseNamespace(owner, path.join(f.config.dataDir, "ownership"));
    await broker.app.close();
    f.close();
  }
});

test("rejected subscriptions and later-expired sessions never receive live private payloads", async () => {
  const f = fixture();
  const recent = f.seed(path.join(f.config.agentDir, "sessions/recent"));
  const old = f.seed(path.join(f.config.agentDir, "sessions/old"));
  const secret = f.seed(path.join(f.config.agentDir, "profile-sessions/librarian"));
  const broker = await createBroker(f.config, { ipc: false });
  const expired = Date.now() - RECENT_SESSION_MS - 2000;
  const recentRow = liveSession(recent, f.root);
  const oldRow = liveSession(old, f.root, expired);
  fs.utimesSync(old.file, expired / 1000, expired / 1000);
  broker.store.save(recentRow);
  broker.store.save(oldRow);
  broker.store.save(liveSession(secret, f.root));
  let socket: WebSocket | undefined;
  try {
    const headers = authentication(broker, f.config.origin);
    const address = await broker.app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/events", {
      headers,
    });
    await once(socket, "open");
    const received: Array<{ type: string; sessionId?: string; data: unknown }> = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    const first = once(socket, "message");
    socket.send(
      JSON.stringify({
        subscriptions: [recent, old, secret].map((saved) => ({
          sessionId: saved.id,
          sequence: 0,
        })),
      }),
    );
    await first;
    oldRow.lastActivity = Date.now();
    broker.store.save(oldRow);
    broker.owners.emit({
      version: 1,
      type: "snapshot",
      sessionId: old.id,
      data: "REJECTED_SUBSCRIPTION",
    });
    broker.owners.emit({
      version: 1,
      type: "snapshot",
      sessionId: secret.id,
      data: "PRIVATE_PROFILE_CONTENT",
    });
    recentRow.lastActivity = expired;
    fs.utimesSync(recent.file, expired / 1000, expired / 1000);
    broker.store.save(recentRow);
    broker.owners.emit({
      version: 1,
      type: "snapshot",
      sessionId: recent.id,
      data: "EXPIRED_CONTENT",
    });
    broker.owners.emit({
      version: 1,
      type: "sessions.changed",
      data: { ...recentRow, name: "PRIVATE_OLD_METADATA" },
    });
    recentRow.lastActivity = Date.now();
    broker.store.save(recentRow);
    const finished = new Promise<void>((resolve) =>
      socket!.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "message_end") resolve();
      }),
    );
    broker.owners.emit({
      version: 1,
      type: "message_end",
      sessionId: recent.id,
      data: "VISIBLE",
    });
    await finished;
    assert(
      !JSON.stringify(received).match(
        /REJECTED_SUBSCRIPTION|PRIVATE_PROFILE_CONTENT|EXPIRED_CONTENT|PRIVATE_OLD_METADATA/,
      ),
    );
    assert.equal(
      received.find((event) => event.type === "sessions.changed")!.data,
      null,
    );
    assert(received.some((event) => event.type === "message_end"));
  } finally {
    if (socket) {
      socket.close();
      await once(socket, "close");
    }
    await broker.app.close();
    f.close();
  }
});

test("authenticated laptop catalog opens saved history; migration blocks process launch without side effects", async () => {
  const f = fixture();
  const saved = f.seed(
    path.join(f.config.agentDir, "sessions/project"),
    randomUUID(),
    "Laptop conversation",
  );
  const broker = await createBroker(f.config, { ipc: false });
  const owner = newOwner("migration");
  try {
    reserveNamespace(owner, path.join(f.config.dataDir, "ownership"));
    const headers = authentication(broker, f.config.origin);
    assert.equal(
      (
        await broker.app.inject({
          url: "/api/v1/sessions",
          headers: { host: headers.host },
        })
      ).statusCode,
      401,
    );
    const response = await broker.app.inject({
      url: `/api/v1/sessions?folder=${encodeURIComponent(f.root)}`,
      headers,
    });
    assert.equal(response.statusCode, 200);
    const rows = response.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, saved.id);
    assert.equal(rows[0].name, "Laptop conversation");
    assert(!response.body.includes("PRIVATE_FIRST_MESSAGE"));
    assert.equal(rows[0].recoveryBlockedReason, "laptop_restart_required");
    const history = await broker.app.inject({
      url: `/api/v1/sessions/${saved.id}/history`,
      headers,
    });
    assert.equal(history.statusCode, 200);
    assert(history.body.includes("PRIVATE_FIRST_MESSAGE"));
    const resumed = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/recover`,
      headers,
    });
    assert.equal(resumed.statusCode, 409);
    assert.equal(resumed.json().error, "laptop_restart_required");
    assert(!fs.existsSync(path.join(f.config.dataDir, "launches")));
    assert.equal(broker.store.sessions().length, 0);
    releaseNamespace(owner, path.join(f.config.dataDir, "ownership"));
    const ready = (
      await broker.app.inject({
        url: `/api/v1/sessions?folder=${encodeURIComponent(f.root)}`,
        headers,
      })
    ).json();
    assert.equal(ready[0].recoveryBlockedReason, undefined);
  } finally {
    await broker.app.close();
    f.close();
  }
});
