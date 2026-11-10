import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TuiFixture, waitFor } from "./tui-fixture.ts";
import { ConfigSchema } from "../src/config.ts";
import { Processes } from "../src/processes.ts";
import { createBroker } from "../src/server.ts";
import {
  activateLaptop,
  inspect,
} from "../../../../extensions/_session_ownership/ownership.mjs";

test(
  "managed Start here registers a fresh native conversation without a first message",
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
    activateLaptop([], fixture.locks);
    const broker = await createBroker(config, { history: false });
    const processes = new Processes(config, broker.owners);
    const tmux = processes.tmux.bind(processes);
    t.mock.method(processes, "tmux", (...args: string[]) =>
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
      const session = await processes.launch(fixture.cwd);
      assert(broker.owners.isConnected(session));
      assert.equal(session.cwd, fixture.cwd);
      assert(session.managed);
      assert(session.sessionFile.startsWith(path.join(fixture.agent, "sessions")));
      assert.equal(fs.existsSync(session.sessionFile), false);
      broker.owners.send(session, {
        version: 1,
        commandId: randomUUID(),
        sessionId: session.sessionId,
        epoch: session.epoch,
        command: { action: "handoff" },
      });
      await waitFor(
        () => !inspect(session.sessionFile, fixture.locks),
        "managed original owner exit",
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
