import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Id } from "../../protocol/src/index.ts";
import { sessionReference } from "../src/session-reference.ts";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import type { Session } from "../../protocol/src/index.ts";
import { ConfigSchema } from "../src/config.ts";
import { History, RECENT_SESSION_MS } from "../src/history.ts";
import { inDeploymentScope } from "../src/deployment-scope.ts";
import { approvePilot, deployment } from "../src/gates.ts";
import { createBroker } from "../src/server.ts";
import { Processes } from "../src/processes.ts";
import { digest } from "../src/store.ts";

function fixture() {
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
  const seed = (directory: string, id: string = randomUUID(), name?: string) => {
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

test("phone resume does not require activation or wait for a previously registered process", async (t) => {
  const f = fixture();
  const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  const row = liveSession(saved, f.root);
  row.state = "disconnected";
  broker.store.save(row);
  let launches = 0;
  t.mock.method(
    Processes.prototype,
    "launch",
    async (cwd: string, native: { id: string; path: string }) => {
      assert.equal(cwd, f.root);
      assert.equal(native.id, saved.id);
      assert.equal(native.path, saved.file);
      launches++;
      return row;
    },
  );
  try {
    const headers = authentication(broker, f.config.origin);
    const detail = await broker.app.inject({
      url: `/api/v1/sessions/${saved.id}`,
      headers,
    });
    assert.equal(detail.json().state, "stopped");
    assert.equal(detail.json().recoveryBlockedReason, undefined);
    const resumed = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/recover`,
      headers,
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(launches, 1);
    assert.equal(fs.existsSync(path.join(f.config.dataDir, "ownership")), false);
  } finally {
    await broker.app.close();
    f.close();
  }
});

test("phone resume reuses an already-connected session", async (t) => {
  const f = fixture();
  const saved = f.seed(path.join(f.config.agentDir, "sessions/project"));
  const broker = await createBroker(f.config, { ipc: false });
  const row = liveSession(saved, f.root);
  broker.store.save(row);
  t.mock.method(broker.connections, "isConnected", () => true);
  t.mock.method(Processes.prototype, "launch", () =>
    assert.fail("connected session must be reused"),
  );
  try {
    const response = await broker.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${saved.id}/recover`,
      headers: authentication(broker, f.config.origin),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().instanceId, row.instanceId);
  } finally {
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
  } finally {
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
    broker.connections.emit({
      version: 1,
      type: "snapshot",
      sessionId: old.id,
      data: "REJECTED_SUBSCRIPTION",
    });
    broker.connections.emit({
      version: 1,
      type: "snapshot",
      sessionId: secret.id,
      data: "PRIVATE_PROFILE_CONTENT",
    });
    recentRow.lastActivity = expired;
    fs.utimesSync(recent.file, expired / 1000, expired / 1000);
    broker.store.save(recentRow);
    broker.connections.emit({
      version: 1,
      type: "snapshot",
      sessionId: recent.id,
      data: "EXPIRED_CONTENT",
    });
    broker.connections.emit({
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
    broker.connections.emit({
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

test("native Neovim IDs share one public reference for live metadata and archived history", async (t) => {
  const f = fixture();
  const saved = f.seed(
    path.join(f.config.agentDir, "sessions/project"),
    "nvim-native-fixture",
    "Native Neovim conversation",
  );
  const original = fs.readFileSync(saved.file);
  const publicId = sessionReference(saved.file, saved.id);
  assert(Id.safeParse(publicId).success);
  const broker = await createBroker(f.config);
  const headers = authentication(broker, f.config.origin);
  const socket = net.connect(path.join(f.config.dataDir, "broker.sock"));
  const lines = createInterface({ input: socket });
  const reader = lines[Symbol.asyncIterator]();
  socket.setTimeout(5000, () => socket.destroy());
  const line = async () => {
    const next = await reader.next();
    assert(!next.done, "Native registration socket closed");
    return JSON.parse(next.value);
  };
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  try {
    send({ secret: broker.connections.secret });
    assert.equal((await line()).type, "ready");
    const registration = {
      version: 1,
      instanceId: randomUUID(),
      pid: process.pid,
      sessionId: saved.id,
      sessionFile: saved.file,
      cwd: f.root,
      name: "Native fixture",
      managed: false,
      model: "fixture/model",
      thinking: "off",
      capabilities: [],
      idle: false,
      loop: false,
    };
    send({ type: "register", data: registration });
    assert.equal((await line()).type, "registered");
    const request = (url: string, method: "GET" | "POST" = "GET", payload?: object) =>
      broker.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const listing = (await request("/api/v1/sessions")).json();
    assert.equal(listing.length, 1);
    assert.equal(listing[0].sessionId, publicId);
    assert.equal(listing[0].state, "running");
    assert.match(listing[0].controlBlockedReason, /\/reload/);
    const folder = (
      await request(`/api/v1/sessions?folder=${encodeURIComponent(f.root)}`)
    ).json();
    assert.equal(folder.length, 1);
    assert.equal(folder[0].name, "Native Neovim conversation");
    assert.equal(folder[0].sessionId, publicId);
    const history = (await request(`/api/v1/sessions/${publicId}/history`)).json();
    assert.equal(history.messages[0].content, "PRIVATE_FIRST_MESSAGE");
    const commandId = randomUUID();
    const blocked = await request(`/api/v1/sessions/${publicId}/actions`, "POST", {
      version: 1,
      commandId,
      sessionId: publicId,
      epoch: 1,
      command: { action: "message", text: "Must not dispatch", images: [] },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, "native_session_reload_required");
    assert.equal(broker.store.command(commandId), undefined);
    send({ type: "register", data: { ...registration, nativeSessionEnvelope: 1 } });
    assert.equal((await line()).type, "registered");
    assert.equal(
      (await request(`/api/v1/sessions/${publicId}`)).json().controlBlockedReason,
      undefined,
    );
    send({ type: "unregister" });
    for (
      let i = 0;
      i < 100 && broker.connections.isConnected(broker.store.session(publicId)!);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    let launches = 0;
    t.mock.method(
      Processes.prototype,
      "launch",
      async (cwd: string, native: { id: string; path: string }) => {
        launches++;
        assert.equal(cwd, f.root);
        assert.equal(native.id, saved.id);
        assert.equal(native.path, saved.file);
        return { ...broker.store.session(publicId)!, state: "idle", epoch: 2 };
      },
    );
    const stopped = await request(`/api/v1/sessions/${publicId}/recover`, "POST", {});
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json().sessionId, publicId);
    assert.equal(launches, 1);
    const archivedDetail = (await request(`/api/v1/sessions/${publicId}`)).json();
    assert.equal(archivedDetail.controlBlockedReason, undefined);
    assert.deepEqual(fs.readFileSync(saved.file), original);
    const archived = (await new History(f.config).byId(publicId))!;
    assert.equal(archived.nativeId, saved.id);
    assert.equal(archived.path, saved.file);
  } finally {
    lines.close();
    socket.destroy();
    await broker.app.close();
    f.close();
  }
});

test(
  "recovery distinguishes disconnected writers from switched-away histories",
  { timeout: 10000 },
  async (t) => {
    const f = fixture();
    const saved = f.seed(
      path.join(f.config.agentDir, "sessions/project"),
      "nvim-disconnected-fixture",
    );
    const broker = await createBroker(f.config);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.title='pi';process.stdout.write('READY');setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(child.stdout!, "data");
      const session = {
        ...liveSession(saved, f.root),
        sessionId: sessionReference(saved.file, saved.id),
        nativeSessionId: saved.id,
        pid: child.pid!,
        state: "disconnected",
      };
      broker.store.save(session);
      const tmux = t.mock.method(Processes.prototype, "tmux", () => {
        throw new Error("Launch reached");
      });
      const response = await broker.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.sessionId}/recover`,
        headers: authentication(broker, f.config.origin),
        payload: {},
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, "session_still_running");
      assert.equal(tmux.mock.callCount(), 0);
      const other = f.seed(path.join(f.config.agentDir, "sessions/project"));
      const switched = {
        ...liveSession(other, f.root),
        instanceId: session.instanceId,
        pid: session.pid,
      };
      broker.store.save(switched);
      t.mock.method(
        broker.connections,
        "isConnected",
        (row: Session) => row.sessionId === switched.sessionId,
      );
      await assert.rejects(
        new Processes(f.config, broker.connections).launch(f.root, {
          id: saved.id,
          path: saved.file,
        }),
        /Launch reached/,
      );
      assert.equal(
        tmux.mock.callCount(),
        1,
        "Switched-away history must reach the launcher",
      );
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
      await broker.app.close();
      f.close();
    }
  },
);
