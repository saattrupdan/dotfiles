import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Processes } from "../src/processes.ts";
import { ConfigSchema } from "../src/config.ts";
import { createBroker } from "../src/server.ts";
import { Envelope } from "../../protocol/src/index.ts";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
test(
  "live laptop Pi auto-connects, persists and steers in its original process, then exits gracefully",
  { skip: process.env.PI_REMOTE_LIVE_PROOF !== "1", timeout: 150000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-proof-"));
    const agentDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const config = ConfigSchema.parse({
      origin: "https://fixture.test.ts.net",
      deploymentPolicy: "pilot",
      pilotScope: "laptop-main",
      sessionDirectories: [path.join(root, "sessions")],
      dataDir: path.join(root, "data"),
      home: root,
      agentDir,
    });
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions);
    const broker = await createBroker(config, { history: false });
    await broker.app.ready();
    const name = `pi-remote-proof-${randomUUID()}`;
    const marker = randomUUID();
    let target = "";
    const tmux = (...args: string[]) =>
      execFileSync(config.tmux, args, { encoding: "utf8", timeout: 10000 });
    const wait = async <T>(read: () => T | undefined, ms = 45000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const result = read();
        if (result) return result;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Live proof deadline expired");
    };
    const processes = new Processes(config, broker.connections);
    let watcher: ReturnType<typeof setInterval> | undefined;
    try {
      target = tmux(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        name,
        "-c",
        root,
      ).trim();
      tmux("set-option", "-t", target, "@pi_agent", marker);
      const pid = tmux("display-message", "-pt", `${target}:0.0`, "#{pane_pid}").trim();
      const shell = path
        .basename(
          execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).trim(),
        )
        .replace(/^-/, "");
      assert(["zsh", "bash", "sh", "fish"].includes(shell));
      const env = {
        PI_REMOTE_DATA_DIR: config.dataDir,
        PI_WORKTREE_ISOLATION_DISABLE: "1",
      };
      const line = [
        "env",
        ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
        quote(path.join(agentDir, "bin", "pi")),
        "--thinking off --session-dir",
        quote(sessions),
      ].join(" ");
      tmux("send-keys", "-t", `${target}:0.0`, "-l", line);
      tmux("send-keys", "-t", `${target}:0.0`, "Enter");
      watcher = setInterval(() => processes.reapIdleShells(), 5000);
      const session = await wait(() =>
        broker.store.sessions().find((s) => broker.connections.isConnected(s)),
      );
      assert.equal(session.cwd, fs.realpathSync(root));
      assert.equal(session.managed, false);
      const originalPid = session.pid;
      const message = Envelope.parse({
        version: 1,
        commandId: randomUUID(),
        sessionId: session.sessionId,
        epoch: session.epoch,
        command: {
          action: "message",
          text: "Reply exactly REMOTE_DELIVERY_OK. Do not use any tools.",
        },
      });
      broker.store.journal(message, "live-proof");
      broker.connections.send(session, message);
      await wait(
        () =>
          broker.store.command(message.commandId)?.status === "persisted"
            ? true
            : undefined,
        90000,
      );
      const native = fs.readFileSync(session.sessionFile, "utf8");
      assert(native.includes("REMOTE_DELIVERY_OK"));
      assert(native.includes(`pi-remote-command:${message.commandId}`));
      broker.connections.send(session, message);
      await new Promise((r) => setTimeout(r, 300));
      const entries = fs
        .readFileSync(session.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        entries.filter((e) => e.type === "message" && e.message.role === "user").length,
        1,
      );
      const running = Envelope.parse({
        version: 1,
        commandId: randomUUID(),
        sessionId: session.sessionId,
        epoch: session.epoch,
        command: {
          action: "message",
          text: "Do not ask any questions. Use the bash tool to run exactly sleep 3, then reply CHECKPOINT_OK.",
        },
      });
      broker.store.journal(running, "live-proof");
      broker.connections.send(session, running);
      await wait(
        () =>
          broker.store.db
            .prepare(
              "SELECT sequence FROM events WHERE session=? AND type='tool_execution_start'",
            )
            .get(session.sessionId),
        60000,
      );
      const checkpoint = Envelope.parse({
        version: 1,
        commandId: randomUUID(),
        sessionId: session.sessionId,
        epoch: session.epoch,
        command: {
          action: "message",
          text: "At the next normal checkpoint, reply exactly STEER_CHECKPOINT_OK instead. Let the running tool finish; do not abort it.",
        },
      });
      broker.store.journal(checkpoint, "live-proof");
      broker.connections.send(session, checkpoint);
      await wait(
        () =>
          broker.store.command(checkpoint.commandId)?.status === "persisted"
            ? true
            : undefined,
        60000,
      );
      const ended = broker.store.db
        .prepare(
          "SELECT sequence,data FROM events WHERE session=? AND type='tool_execution_end' ORDER BY sequence DESC LIMIT 1",
        )
        .get(session.sessionId) as { sequence: number; data: string } | undefined;
      assert(ended);
      assert.equal(JSON.parse(ended.data).isError, false);
      const consumed = broker.store.db
        .prepare(
          "SELECT sequence FROM events WHERE session=? AND type='message_end' AND data LIKE ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(session.sessionId, `%pi-remote-command:${checkpoint.commandId}%`) as
        { sequence: number } | undefined;
      assert(
        consumed && consumed.sequence > ended.sequence,
        "Steering input must be consumed after tool completion",
      );
      assert.equal(broker.store.session(session.sessionId)!.pid, originalPid);
      assert.equal(broker.store.sessions().length, 1);
      const handoff = Envelope.parse({
        version: 1,
        commandId: randomUUID(),
        sessionId: session.sessionId,
        epoch: session.epoch,
        command: { action: "stop_session" },
      });
      broker.store.journal(handoff, "live-proof");
      broker.connections.send(session, handoff);
      await wait(
        () =>
          !broker.connections.isConnected(session)
            ? true
            : undefined,
        30000,
      );
      const finalNative = fs.readFileSync(session.sessionFile, "utf8");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fs.readFileSync(session.sessionFile, "utf8"), finalNative);
      console.log(
        "Live proof: registered original session; persisted native command marker; duplicate ID injected once; busy steering followed tool completion; graceful stop confirmed actual exit.",
      );
    } catch (error) {
      if (target)
        console.error(tmux("capture-pane", "-pt", `${target}:0.0`, "-S", "-35"));
      throw error;
    } finally {
      if (watcher) clearInterval(watcher);
      if (target) {
        try {
          if (tmux("show-option", "-qv", "-t", target, "@pi_agent").trim() === marker)
            tmux("kill-session", "-t", target);
        } catch {
          /* The synthetic session already exited. */
        }
      }
      await broker.app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
