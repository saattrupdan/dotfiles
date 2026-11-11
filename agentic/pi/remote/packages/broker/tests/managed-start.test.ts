import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TuiFixture, waitFor } from "./tui-fixture.ts";
import { ConfigSchema } from "../src/config.ts";
import { Processes } from "../src/processes.ts";
import { digest } from "../src/store.ts";
import { sessionReference } from "../src/session-reference.ts";
import { createBroker } from "../src/server.ts";

for (const nativeId of [undefined, `nvim-phone-${randomUUID()}`])
  test(
    nativeId
      ? "phone resumes stopped Neovim history and persists its first message in the same file"
      : "phone creates a fresh laptop conversation and persists its first message",
    {
      skip: process.env.PI_REMOTE_LIVE_PROOF !== "1",
      timeout: 70000,
    },
    async (t) => {
      const fixture = new TuiFixture();
      fs.mkdirSync(path.join(fixture.agent, "bin"));
      fs.symlinkSync(
        path.join(fixture.source, "bin/pi"),
        path.join(fixture.agent, "bin/pi"),
      );
      const config = ConfigSchema.parse({
        origin: "https://fixture.test.ts.net",
        home: fixture.root,
        agentDir: fixture.agent,
        dataDir: fixture.data,
        deploymentPolicy: "pilot",
        pilotScope: "laptop-main",
      });
      fs.writeFileSync(path.join(fixture.data, "config.json"), JSON.stringify(config));
      const broker = await createBroker(config);
      const device = randomUUID(),
        raw = randomUUID(),
        csrf = randomUUID(),
        now = Date.now();
      broker.store.db
        .prepare("INSERT INTO devices VALUES (?,?,?,0,?)")
        .run(device, "Proof", "{}", now);
      broker.store.db
        .prepare("INSERT INTO auth VALUES (?,?,?,?,?,?,?,?)")
        .run(digest(raw), device, csrf, now, now, null, now + 86400000, 1);
      const headers = {
        host: new URL(config.origin).host,
        origin: config.origin,
        cookie: `__Host-pi-remote=${raw}`,
        "x-pi-csrf": csrf,
      };
      const savedFile = path.join(fixture.sessionDir(), "stopped-native.jsonl");
      if (nativeId) {
        fs.mkdirSync(path.dirname(savedFile), { recursive: true });
        fs.writeFileSync(
          savedFile,
          JSON.stringify({
            type: "session",
            version: 3,
            id: nativeId,
            timestamp: new Date().toISOString(),
            cwd: fixture.cwd,
          }) + "\n",
        );
      }
      const processes = new Processes(config, broker.connections);
      const tmux = processes.tmux.bind(processes);
      t.mock.method(Processes.prototype, "tmux", (...args: string[]) =>
        tmux(
          ...args,
          ...(args[0] === "new-session"
            ? [
                "-e",
                "PI_SUBAGENT_CHILD=1",
                "-e",
                `PI_CODING_AGENT_SESSION_DIR=${fixture.root}/stale-history`,
              ]
            : []),
        ),
      );
      const before = fixture
        .tmux("list-sessions", "-F", "#{session_name}")
        .trim()
        .split("\n");
      try {
        const publicId = nativeId ? sessionReference(savedFile, nativeId) : undefined;
        const response = await broker.app.inject({
          method: "POST",
          url: publicId ? `/api/v1/sessions/${publicId}/recover` : "/api/v1/sessions",
          headers,
          payload: publicId ? {} : { cwd: fixture.cwd },
        });
        assert.equal(response.statusCode, 200, response.body);
        let session = response.json();
        assert(broker.connections.isConnected(session));
        assert.equal(session.cwd, fixture.cwd);
        assert(session.managed);
        assert(session.sessionFile.startsWith(path.join(fixture.agent, "sessions")));
        if (nativeId) {
          assert.equal(session.sessionId, publicId);
          assert.equal(session.sessionFile, savedFile);
          assert.equal(session.nativeSessionId, nativeId);
        } else assert.equal(fs.existsSync(session.sessionFile), false);
        const commandId = randomUUID();
        const sent = await broker.app.inject({
          method: "POST",
          url: `/api/v1/sessions/${session.sessionId}/actions`,
          headers,
          payload: {
            version: 1,
            commandId,
            sessionId: session.sessionId,
            epoch: session.epoch,
            command: {
              action: "message",
              text: "Reply exactly PHONE_START_SEND_OK. Do not use tools.",
              images: [],
            },
          },
        });
        assert.equal(sent.statusCode, 200, sent.body);
        await waitFor(
          () => broker.store.command(commandId)?.status === "persisted",
          "phone message persisted in native history",
          60000,
        );
        const entries = fs
          .readFileSync(session.sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(entries[0].id, nativeId ?? session.sessionId);
        assert.equal(
          entries.filter(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes(
                `pi-remote-command:${commandId}`,
              ),
          ).length,
          1,
        );
        assert.equal(broker.store.session(session.sessionId)!.pid, session.pid);
        if (nativeId) {
          await waitFor(
            () => broker.store.session(session.sessionId)?.state === "idle",
            "native response settled",
          );
          tmux("send-keys", "-t", `${session.tmux}:0.0`, "C-n");
          const switched = await waitFor(
            () =>
              broker.store
                .sessions()
                .find(
                  (row) =>
                    row.pid === session.pid &&
                    row.sessionId !== session.sessionId &&
                    broker.connections.isConnected(row),
                ),
            "native process switched to another conversation",
          );
          const resumed = await broker.app.inject({
            method: "POST",
            url: `/api/v1/sessions/${session.sessionId}/recover`,
            headers,
            payload: {},
          });
          assert.equal(resumed.statusCode, 200, resumed.body);
          const reconnected = resumed.json();
          assert.equal(reconnected.sessionId, session.sessionId);
          assert.equal(reconnected.sessionFile, savedFile);
          assert.notEqual(reconnected.pid, switched.pid);
          assert(
            broker.connections.isConnected(switched),
            "Other native conversation remains connected",
          );
          session = reconnected;
          broker.connections.send(switched, {
            version: 1,
            commandId: randomUUID(),
            sessionId: switched.sessionId,
            epoch: switched.epoch,
            command: { action: "stop_session" },
          });
          await waitFor(
            () => !broker.connections.isConnected(switched),
            "switched synthetic session stopped",
          );
        }
        broker.connections.send(session, {
          version: 1,
          commandId: randomUUID(),
          sessionId: session.sessionId,
          epoch: session.epoch,
          command: { action: "stop_session" },
        });
        await waitFor(
          () => !broker.connections.isConnected(session),
          "managed original process exit",
        );
      } catch (error) {
        const names = fixture
          .tmux("list-sessions", "-F", "#{session_name}")
          .trim()
          .split("\n");
        for (const name of names.filter(
          (item) => item.startsWith("pi-remote-") && !before.includes(item),
        )) {
          if (
            fixture
              .tmux("display-message", "-pt", name, "#{pane_current_path}")
              .trim()
              .startsWith(fixture.root)
          )
            console.error(fixture.tmux("capture-pane", "-pt", name, "-S", "-40"));
        }
        throw error;
      } finally {
        const names = fixture
          .tmux("list-sessions", "-F", "#{session_name}")
          .trim()
          .split("\n");
        for (const name of names.filter(
          (item) => item.startsWith("pi-remote-") && !before.includes(item),
        )) {
          if (
            fixture
              .tmux("display-message", "-pt", name, "#{pane_current_path}")
              .trim()
              .startsWith(fixture.root)
          )
            fixture.tmux("kill-session", "-t", name);
        }
        await broker.app.close();
        await fixture.close();
      }
    },
  );
