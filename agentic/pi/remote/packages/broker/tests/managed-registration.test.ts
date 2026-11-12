import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Connections } from "../src/ipc.ts";
import { Store } from "../src/store.ts";
import { Processes } from "../src/processes.ts";
import { ConfigSchema } from "../src/config.ts";
import {
  registeredWorkingDirectory,
  inDeploymentScope,
} from "../src/deployment-scope.ts";
import { sessionReference } from "../src/session-reference.ts";

export function managedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-managed-registration-"));
  const project = path.join(root, "project"),
    agent = path.join(root, "agent"),
    data = path.join(root, "data");
  fs.mkdirSync(project);
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], { stdio: "pipe", timeout: 10000 });
  git("init");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const common = fs.realpathSync(path.join(project, ".git")),
    key = createHash("sha256").update(common).digest("hex").slice(0, 12);
  const worktree = path.join(agent, "worktrees", key, "golden-heron");
  git("worktree", "add", "--detach", worktree);
  const file = path.join(agent, "sessions", "fixture.jsonl"),
    native = "nvim-managed-fixture";
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", id: native, cwd: project }) + "\n",
  );
  const manifest = path.join(common, "pi-worktree-sessions", "golden-heron.json");
  fs.mkdirSync(path.dirname(manifest));
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      id: "golden-heron",
      repoRoot: project,
      commonGitDir: common,
      worktreeRoot: worktree,
      sessionHubCwd: project,
      agentDir: agent,
      manifestPath: manifest,
      ownerPid: 999999,
    }),
  );
  const config = ConfigSchema.parse({
    origin: "https://fixture.test.ts.net",
    deploymentPolicy: "pilot",
    pilotScope: "laptop-main",
    dataDir: data,
    home: root,
    agentDir: agent,
  });
  return {
    root,
    project,
    agent,
    data,
    common,
    worktree,
    file,
    native,
    manifest,
    config,
  };
}

test("a resumed parent inside its managed worktree registers as active during subagent work", async () => {
  const f = managedFixture(),
    store = new Store(f.data);
  const publicId = sessionReference(f.file, f.native);
  const registration = {
    version: 1 as const,
    sessionId: f.native,
    instanceId: randomUUID(),
    nativeSessionEnvelope: 1 as const,
    sessionFile: f.file,
    cwd: f.project,
    pid: 999999,
    name: "Reviewing and Fixing Holi Prs",
    managed: false,
    model: "fixture/model",
    thinking: "off",
    capabilities: [],
    idle: true,
    loop: false,
  };
  store.save({
    ...registration,
    sessionId: publicId,
    nativeSessionId: f.native,
    epoch: 1,
    sequence: 0,
    state: "interrupted",
    lastActivity: Date.now(),
  });
  const connections = new Connections(f.config, store, () => {});
  await connections.listen();
  const socket = net.connect(path.join(f.data, "broker.sock"));
  socket.setEncoding("utf8");
  let buffer = "";
  const queue: Record<string, unknown>[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      queue.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  const wait = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const at = queue.findIndex((row) => row.type === type);
      if (at >= 0) return queue.splice(at, 1)[0]!;
      if (socket.destroyed) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(
      `Missing ${type}: managed parent was rejected and remains absent from Active`,
    );
  };
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  try {
    send({ secret: connections.secret });
    await wait("ready");
    send({
      type: "register",
      data: {
        ...registration,
        instanceId: randomUUID(),
        cwd: f.worktree,
        pid: process.pid,
        idle: false,
      },
    });
    await wait("registered");
    let row = store.session(publicId)!;
    assert.equal(row.cwd, f.project);
    assert.equal((row as typeof row & { runtimeCwd?: string }).runtimeCwd, f.worktree);
    assert.equal(row.pid, process.pid);
    assert.equal(row.state, "running");
    assert(connections.isConnected(row));
    send({
      type: "event",
      kind: "tool_execution_start",
      data: { toolCallId: "child", name: "subagent" },
    });
    send({ type: "heartbeat", data: { idle: false, loop: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    row = store.session(publicId)!;
    assert.equal(row.state, "running");
    assert.equal(connections.workingMessage(row), "Whipping the subagents...");
    const processes = new Processes(f.config, connections);
    processes.tmux = () => {
      throw new Error("Must not launch a second writer for an active parent");
    };
    assert.equal(
      (await processes.launch(f.project, { id: f.native, path: f.file })).pid,
      process.pid,
    );
    send({
      type: "event",
      kind: "tool_progress",
      data: {
        toolCallId: "child",
        toolDisplay: "subagent\nLive output",
        toolDisplayStyles: ["plain", "plain"],
        rawChildMessages: "must not be transported",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(connections.progress(store.session(publicId)!).length, 1);
    assert.doesNotMatch(
      JSON.stringify(connections.progress(store.session(publicId)!)),
      /rawChildMessages|must not be transported/,
    );
    send({
      type: "event",
      kind: "tool_execution_end",
      data: { toolCallId: "child", name: "subagent" },
    });
    send({
      type: "event",
      kind: "message_end",
      data: { role: "assistant", stopReason: "error", errorMessage: "Private failure" },
    });
    send({ type: "event", kind: "agent_settled", data: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(connections.progress(store.session(publicId)!).length, 0);
    const outcome = () =>
      JSON.parse(
        store.db
          .prepare(
            "SELECT data FROM events WHERE session=? AND type='agent_settled' ORDER BY sequence DESC LIMIT 1",
          )
          .get(publicId)!.data as string,
      ).outcome;
    assert.equal(outcome(), "failed");
    send({ type: "event", kind: "agent_start", data: null });
    send({
      type: "event",
      kind: "message_end",
      data: { role: "assistant", stopReason: "stop" },
    });
    send({ type: "event", kind: "agent_settled", data: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(outcome(), "finished");
    send({
      type: "event",
      kind: "agent_settled",
      data: { loopIteration: true, privateText: "never copy" },
    });
    const completionId = randomUUID();
    const completion = {
      type: "event",
      kind: "loop_completed",
      data: { id: completionId, outcome: "finished", privateText: "never copy" },
    };
    send(completion);
    send(completion);
    send({ ...completion, data: { id: "invalid", outcome: "finished" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lastSettled = store.db
      .prepare(
        "SELECT data FROM events WHERE session=? AND type='agent_settled' ORDER BY sequence DESC LIMIT 1",
      )
      .get(publicId)!;
    assert.deepEqual(JSON.parse(lastSettled.data as string), {
      outcome: "finished",
      loopIteration: true,
    });
    const completions = store.db
      .prepare("SELECT data FROM events WHERE session=? AND type='loop_completed'")
      .all(publicId);
    assert.deepEqual(
      completions.map((entry) => JSON.parse(entry.data as string)),
      [{ id: completionId, outcome: "finished" }],
      "terminal notification is validated, stripped and emitted once",
    );
    // A normal reconnect/registration must not forget the terminal notification ID.
    send({
      type: "register",
      data: {
        ...registration,
        instanceId: row.instanceId,
        cwd: f.worktree,
        pid: process.pid,
      },
    });
    await wait("registered");
    send(completion);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS count FROM events WHERE session=? AND type='loop_completed'",
        )
        .get(publicId)!.count,
      1,
    );
  } finally {
    if (!socket.destroyed) {
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
    }
    await new Promise<void>((resolve) => connections.server.close(() => resolve()));
    store.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("managed worktree scope fails closed on private paths and mismatched metadata", () => {
  const f = managedFixture();
  try {
    assert.deepEqual(registeredWorkingDirectory(f.config, f.worktree), {
      cwd: f.project,
      runtimeCwd: f.worktree,
    });
    for (const cwd of [
      f.agent,
      path.join(f.agent, "profile-sessions"),
      path.join(f.agent, "extensions"),
      path.join(f.agent, "worktrees", "arbitrary"),
    ])
      assert.equal(registeredWorkingDirectory(f.config, cwd), undefined);
    const original = fs.readFileSync(f.manifest, "utf8"),
      meta = JSON.parse(original);
    for (const changes of [
      { worktreeRoot: f.agent },
      { commonGitDir: f.agent },
      { repoRoot: f.agent },
      { sessionHubCwd: f.agent },
      { agentDir: f.project },
      { manifestPath: f.file },
      { version: 2 },
    ]) {
      fs.writeFileSync(f.manifest, JSON.stringify({ ...meta, ...changes }));
      assert.equal(
        registeredWorkingDirectory(f.config, f.worktree),
        undefined,
        JSON.stringify(changes),
      );
    }
    fs.writeFileSync(f.manifest, original);
    fs.symlinkSync(f.agent, path.join(f.worktree, "private-hop"));
    assert.equal(
      registeredWorkingDirectory(f.config, path.join(f.worktree, "private-hop")),
      undefined,
    );
    fs.renameSync(f.manifest, f.manifest + ".saved");
    fs.symlinkSync(f.manifest + ".saved", f.manifest);
    assert.equal(registeredWorkingDirectory(f.config, f.worktree), undefined);
    fs.unlinkSync(f.manifest);
    fs.renameSync(f.manifest + ".saved", f.manifest);
    const directory = registeredWorkingDirectory(f.config, f.worktree)!;
    assert.equal(
      inDeploymentScope(f.config, {
        ...directory,
        managed: false,
        sessionFile: path.join(f.agent, "profile-sessions", "private.jsonl"),
      }),
      false,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
