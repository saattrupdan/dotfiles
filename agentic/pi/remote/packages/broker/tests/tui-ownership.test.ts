import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { ConfigSchema } from "../src/config.ts";
import { createBroker } from "../src/server.ts";
import { TuiFixture, waitFor, type Pane } from "./tui-fixture.ts";
import {
  activateLaptop,
  acquire,
  newOwner,
  release,
  isAlive,
  inspect,
} from "../../../../extensions/_session_ownership/ownership.mjs";

for (const mode of ["terminal", "neovim"] as const) {
  test(
    `real ${mode}: broker-down resume, cancellation, reload, fork and new preserve ownership`,
    { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 120000 },
    async () => {
      const fixture = new TuiFixture();
      let pane: Pane | undefined;
      try {
        const seed = await fixture.seed("resume-fixture");
        pane = await fixture.launch(mode, mode);
        const first = await fixture.start(pane);
        const owner = fixture.owned(first);
        let offset = fixture.events(pane!.label).length;
        fixture.command(pane, "/reload");
        const reloaded = await fixture.start(pane, offset);
        assert.equal(reloaded.id, first.id);
        assert.equal(reloaded.pid, first.pid);
        assert.equal(fixture.owned(reloaded).instanceId, owner.instanceId);
        fixture.command(pane, `/resume ${seed.id}`);
        await fixture.screenHas(pane, "Resume conversation");
        fixture.keys(pane, "Escape");
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(fixture.latest(pane)!.id, first.id);
        fixture.owned(first);
        assert.equal(inspect(seed.file, fixture.locks), undefined);
        fs.writeFileSync(fixture.env.PI_PROOF_CANCEL!, "cancel");
        offset = fixture.events(pane!.label).length;
        fixture.command(pane, `/resume ${seed.id}`);
        await fixture.screenHas(pane, "Resume conversation");
        fixture.keys(pane, "Enter");
        await waitFor(
          () =>
            fixture
              .events(pane!.label)
              .slice(offset)
              .find((e) => e.kind === "cancel_switch"),
          "native switch cancellation",
        );
        await new Promise((r) => setTimeout(r, 100));
        fixture.owned(first);
        const competitor = newOwner();
        acquire(seed.file, competitor, fixture.locks);
        release(seed.file, competitor, fixture.locks);
        fs.unlinkSync(fixture.env.PI_PROOF_CANCEL!);
        offset = fixture.events(pane!.label).length;
        fixture.command(pane, `/resume ${seed.id}`);
        await fixture.screenHas(pane, "Resume conversation");
        fixture.keys(pane, "Enter");
        const resumed = await fixture.start(pane, offset);
        assert.equal(resumed.id, seed.id);
        fixture.owned(resumed);
        assert.equal(inspect(first.file, fixture.locks), undefined);
        fixture.command(pane, "/tree");
        await fixture.screenHas(pane, "Session Tree");
        fixture.keys(pane, "Home", "Enter");
        await fixture.screenHas(pane, "Summarize branch?");
        fixture.keys(pane, "Enter");
        await fixture.screenHas(pane, "Navigated to selected point");
        fixture.owned(resumed);
        fixture.keys(pane, "C-u");
        fixture.keys(pane, "C-f");
        await fixture.screenHas(pane, "Fork before user message");
        fixture.keys(pane, "Escape");
        await new Promise((r) => setTimeout(r, 200));
        fixture.owned(resumed);
        offset = fixture.events(pane!.label).length;
        fixture.command(pane, "/fork");
        await fixture.screenHas(pane, "Fork before user message");
        fixture.keys(pane, "Enter");
        const forked = await fixture.start(pane, offset);
        assert.notEqual(forked.id, resumed.id);
        fixture.owned(forked);
        assert.equal(inspect(resumed.file, fixture.locks), undefined);
        // Fork restores the selected prompt into the editor; clear it before invoking /new.
        fixture.keys(pane, "C-u");
        offset = fixture.events(pane!.label).length;
        fixture.command(pane, "/new");
        const fresh = await fixture.start(pane, offset);
        assert.notEqual(fresh.id, forked.id);
        fixture.owned(fresh);
        assert.equal(inspect(forked.file, fixture.locks), undefined);
        fixture.keys(pane, "C-r");
        await fixture.screenHas(pane, "Resume conversation");
        fixture.keys(pane, "Escape");
        await new Promise((r) => setTimeout(r, 150));
        offset = fixture.events(pane!.label).length;
        fixture.keys(pane, "C-n");
        const keyed = await fixture.start(pane, offset);
        assert.notEqual(keyed.id, fresh.id);
        fixture.owned(keyed);
        assert.equal(inspect(fresh.file, fixture.locks), undefined);
        assert(!fixture.events().some((e) => e.kind === "unexpected_input"));
        assert.equal(fs.existsSync(fixture.data + "/broker.sock"), false);
      } catch (error) {
        if (pane)
          console.error(
            fixture.screen(pane),
            JSON.stringify(fixture.events(pane!.label)),
          );
        throw error;
      } finally {
        await fixture.close();
      }
    },
  );
}

test(
  "real terminal: /resume discovers a custom session directory",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture(true);
    let pane: Pane | undefined;
    try {
      const seed = await fixture.seed("custom-directory");
      pane = await fixture.launch("custom");
      await fixture.start(pane);
      fixture.command(pane, `/resume ${seed.id}`);
      await fixture.screenHas(pane, "Resume conversation");
      fixture.keys(pane, "Enter");
      await fixture.start(pane, 1);
      assert.equal(fixture.latest(pane)!.id, seed.id);
    } catch (error) {
      if (pane)
        console.error(
          fixture.screen(pane),
          JSON.stringify(fixture.events(pane!.label)),
        );
      throw error;
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real terminal: saved sessions appear without scanning multi-GB transcripts",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture(true);
    let pane: Pane | undefined;
    try {
      const seed = await fixture.seed("large-history");
      const fd = fs.openSync(seed.file, "r+");
      try {
        const end = 4 * 1024 ** 3;
        fs.ftruncateSync(fd, end);
        fs.writeSync(fd, '\n{"type":"session_info","name":"Large saved conversation"}\n', end);
      } finally {
        fs.closeSync(fd);
      }
      pane = await fixture.launch("large-history");
      const initial = await fixture.start(pane);
      const start = Date.now();
      fixture.command(pane, `/resume ${seed.id}`);
      await fixture.screenHas(pane, "Large saved conversation");
      assert(Date.now() - start < 5000, "picker must not wait for transcript loading");
      fixture.keys(pane, "Escape");
      await waitFor(
        () => !fixture.screen(pane!).includes("Resume conversation"),
        "large-history picker cancellation",
      );
      fixture.command(pane, "/ownership-proof-ready");
      await waitFor(
        () => fixture.events(pane!.label).some((event) => event.kind === "ready"),
        "editor ready after picker cancellation",
      );
      assert.equal(fixture.latest(pane)!.id, initial.id);
      fixture.owned(initial);
      assert.equal(inspect(seed.file, fixture.locks), undefined);
    } catch (error) {
      if (pane) console.error(fixture.screen(pane));
      throw error;
    } finally {
      await fixture.close();
    }
  },
);

for (const destinationMode of ["terminal", "neovim"] as const) {
  test(
    `real ${destinationMode}: competing owner, transfer cancellation, broker outage and confirmed exit`,
    { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 150000 },
    async () => {
      const fixture = new TuiFixture();
      const config = ConfigSchema.parse({
        origin: "https://fixture.test.ts.net",
        dataDir: fixture.data,
        home: fixture.root,
        agentDir: fixture.agent,
        deploymentPolicy: "pilot",
        pilotScope: "laptop-main",
      });
      activateLaptop([], fixture.locks);
      let broker: Awaited<ReturnType<typeof createBroker>> | undefined;
      let destination: Pane | undefined;
      try {
        broker = await createBroker(config, { history: false });
        await broker.app.ready();
        const seed = await fixture.seed("held-fixture");
        const source = await fixture.launch(
          "source",
          destinationMode === "terminal" ? "neovim" : "terminal",
          [],
          { PI_PROOF_DELAY: "1", PI_PROOF_MODEL: "1" },
        );
        await fixture.start(source);
        let offset = fixture.events(source.label).length;
        fixture.command(source, `/resume ${seed.id}`);
        await fixture.screenHas(source, "Resume conversation");
        fixture.keys(source, "Enter");
        const held = await fixture.start(source, offset);
        const holder = fixture.owned(held);
        await waitFor(() => {
          const s = broker!.store.session(seed.id);
          return s && broker!.owners.isConnected(s);
        }, "source registration");
        const before = fs.readFileSync(seed.file, "utf8");
        const collision = await fixture.launch("collision", "terminal", [
          "--session",
          seed.file,
        ]);
        await fixture.screenHas(collision, "Session owned by");
        assert.equal(fixture.events(collision.label).length, 0);
        assert.equal(fs.readFileSync(seed.file, "utf8"), before);
        destination = await fixture.launch("destination", destinationMode);
        const initial = await fixture.start(destination);
        const offer = async () => {
          fixture.command(destination!, `/resume ${seed.id}`);
          await fixture.screenHas(destination!, "Resume conversation");
          fixture.keys(destination!, "Enter");
          await fixture.screenHas(
            destination!,
            "Transfer conversation from Pi process",
          );
        };
        fixture.command(destination, `/resume ${seed.id}`);
        await fixture.screenHas(destination, "Resume conversation");
        fixture.keys(destination, "C-d", "C-r", "Delete");
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(fs.readFileSync(seed.file, "utf8"), before);
        fixture.keys(destination, "Escape");
        await new Promise((r) => setTimeout(r, 150));
        await offer();
        fixture.keys(destination, "Down", "Enter");
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(fixture.latest(destination)!.id, initial.id);
        fixture.owned(held);
        assert.equal(fs.readFileSync(seed.file, "utf8"), before);
        await broker.app.close();
        broker = undefined;
        await offer();
        fixture.keys(destination, "Enter");
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(fixture.latest(destination)!.id, initial.id);
        assert(isAlive(holder));
        fixture.owned(held);
        assert.equal(fs.readFileSync(seed.file, "utf8"), before);
        broker = await createBroker(config, { history: false });
        await broker.app.ready();
        await waitFor(() => {
          const s = broker!.store.session(seed.id);
          return s && broker!.owners.isConnected(s);
        }, "source reconnects to recovered broker");
        fixture.command(
          source,
          "Do not ask questions. Use the bash tool to run exactly sleep 3, then reply TOOL_FINISHED. Do not use other tools.",
        );
        const activeTool = await waitFor(
          () =>
            fixture
              .events(source.label)
              .find(
                (e) =>
                  e.kind === "tool_start" &&
                  e.tool === "bash" &&
                  e.command === "sleep 3",
              ),
          "source tool is running",
          60000,
        );
        offset = fixture.events(source.label).length;
        const destinationOffset = fixture.events(destination.label).length;
        await offer();
        fixture.keys(destination, "Enter");
        const accepted = await waitFor(
          () =>
            broker!.store.db
              .prepare(
                "SELECT updated FROM commands WHERE session=? AND status='accepted_by_owner' ORDER BY updated DESC LIMIT 1",
              )
              .get(seed.id) as { updated: number } | undefined,
          "handoff is accepted while the tool runs",
        );
        await waitFor(
          () =>
            fixture
              .events(source.label)
              .slice(offset)
              .find((e) => e.kind === "shutdown_wait"),
          "source shutdown is draining",
        );
        const toolEnd = fixture.events(source.label).find((e) => e.kind === "tool_end");
        const shuttingDown = fixture
          .events(source.label)
          .slice(offset)
          .find((e) => e.kind === "shutdown_wait");
        assert(
          toolEnd && activeTool.at <= accepted.updated && accepted.updated < toolEnd.at,
          "Owner must accept transfer while the exact sleep-3 call is still active",
        );
        assert(
          toolEnd && shuttingDown && toolEnd.at <= shuttingDown.at,
          "Handoff must let the active tool finish successfully",
        );
        assert(!fixture.events(source.label).some((e) => e.kind === "tool_error"));
        assert(isAlive(holder));
        assert.equal(fixture.owned(held).instanceId, holder.instanceId);
        assert.equal(fixture.latest(destination)!.id, initial.id);
        const transferred = await fixture.start(destination, destinationOffset);
        assert.equal(transferred.id, seed.id);
        assert.equal(isAlive(holder), false);
        fixture.owned(transferred);
        assert.equal(inspect(initial.file, fixture.locks), undefined);
        const last = fixture
          .events(source.label)
          .filter((e) => e.kind === "shutdown_written")
          .at(-1)!;
        assert(last.at <= transferred.at);
        assert(
          fs.readFileSync(seed.file, "utf8").includes("ownership-proof-last-write"),
        );
      } catch (error) {
        if (destination) console.error(fixture.screen(destination));
        throw error;
      } finally {
        await fixture.close();
        if (broker) await broker.app.close();
      }
    },
  );
}

for (const mode of ["terminal", "neovim"] as const) {
  test(
    `real ${mode}: supervised worktree continuation and return retain exclusive history`,
    { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 150000 },
    async () => {
      const fixture = new TuiFixture();
      let pane: Pane | undefined;
      try {
        const repo = path.join(fixture.root, "repository");
        fs.mkdirSync(repo);
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: repo, encoding: "utf8" });
        git("init", "-b", "main");
        git("config", "user.name", "Ownership proof");
        git("config", "user.email", "ownership@example.invalid");
        fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture\n");
        git("add", ".");
        git("commit", "-m", "fixture");
        const origin = path.join(fixture.root, "origin.git");
        execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
        git("remote", "add", "origin", origin);
        git("push", "-u", "origin", "main");
        const seed = await fixture.seed("worktree-fixture", repo);
        pane = await fixture.launch(
          "worktree",
          mode,
          mode === "terminal" ? ["--session", seed.file] : [],
          {
            PI_WORKTREE_ISOLATION_DISABLE: "0",
            PI_PROOF_DELAY: "1",
            PI_PROOF_MODEL: "1",
          },
          repo,
        );
        let original = await fixture.start(pane);
        if (mode === "neovim") {
          const selectedOffset = fixture.events(pane.label).length;
          fixture.command(pane, `/resume ${seed.id}`);
          await fixture.screenHas(pane, "Resume conversation");
          fixture.keys(pane, "Enter");
          original = await fixture.start(pane, selectedOffset);
        }
        const owner = fixture.owned(original);
        const offset = fixture.events(pane!.label).length;
        fixture.command(
          pane,
          "Do not ask questions. Call isolated_new_branch with name pi-ownership-proof. Do not edit files or clean up the branch. After the handoff reply exactly BRANCH_READY.",
        );
        await waitFor(
          () =>
            fixture
              .events(pane!.label)
              .slice(offset)
              .find((e) => e.kind === "shutdown_wait"),
          "worktree source shutdown",
          90000,
        );
        assert(isAlive(owner));
        fixture.owned(original);
        const continued = await fixture.start(pane, offset);
        assert.equal(continued.id, original.id);
        assert.notEqual(continued.pid, original.pid);
        assert.equal(isAlive(owner), false);
        fixture.owned(continued);
        assert.notEqual(continued.cwd, repo);
        assert.equal(git("branch", "--show-current").trim(), "main");
        await waitFor(
          () =>
            fixture
              .events(pane!.label)
              .some((e) => e.kind === "settled" && e.pid === continued.pid),
          "worktree successor settles",
          60000,
        );
        const returnOffset = fixture.events(pane!.label).length;
        fixture.command(pane, "/clean-up-isolated-branch");
        const returned = await fixture.start(pane, returnOffset);
        assert.equal(returned.id, original.id);
        assert.equal(returned.cwd, repo);
        fixture.owned(returned);
        assert.notEqual(returned.pid, continued.pid);
        assert.equal(fs.existsSync(continued.cwd), false);
      } catch (error) {
        if (pane)
          console.error(
            fixture.screen(pane),
            JSON.stringify(fixture.events(pane!.label)),
          );
        throw error;
      } finally {
        await fixture.close();
      }
    },
  );
}

test(
  "real terminals: simultaneous saved-session startup admits exactly one writer",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture();
    try {
      const seed = await fixture.seed("contended-startup");
      const panes = await Promise.all([
        fixture.launch("contender-a", "terminal", ["--session", seed.file]),
        fixture.launch("contender-b", "terminal", ["--session", seed.file]),
      ]);
      await waitFor(
        () => panes.some((p) => fixture.screen(p).includes("Session owned by")),
        "competing startup fails closed",
      );
      const winner = await waitFor(
        () => panes.find((p) => fixture.latest(p)),
        "one contender owns the session",
      );
      const started = await fixture.start(winner);
      assert.equal(started.id, seed.id);
      fixture.owned(started);
      assert.equal(fixture.events().filter((e) => e.kind === "start").length, 1);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real terminal to Neovim: crash restoration and uncertain ownership fail closed",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture();
    try {
      const seed = await fixture.seed("crash-restoration");
      const first = await fixture.launch("crashed", "terminal", [
        "--session",
        seed.file,
      ]);
      const original = await fixture.start(first);
      const originalOwner = fixture.owned(original);
      process.kill(original.pid, "SIGKILL");
      await waitFor(() => !isAlive(originalOwner), "crashed process exits");
      const before = fs.readFileSync(seed.file, "utf8");
      const db = new DatabaseSync(path.join(fixture.locks, "locks.sqlite"));
      const row = db.prepare("SELECT record FROM locks WHERE key=?").get(seed.file) as {
        record: string;
      };
      db.prepare("UPDATE locks SET record='broken' WHERE key=?").run(seed.file);
      db.close();
      const uncertain = await fixture.launch("uncertain", "terminal", [
        "--session",
        seed.file,
      ]);
      await fixture.screenHas(uncertain, "Uncertain ownership record");
      assert.equal(fixture.events(uncertain.label).length, 0);
      assert.equal(fs.readFileSync(seed.file, "utf8"), before);
      const repaired = new DatabaseSync(path.join(fixture.locks, "locks.sqlite"));
      repaired
        .prepare("UPDATE locks SET record=? WHERE key=?")
        .run(row.record, seed.file);
      repaired.close();
      const restored = await fixture.launch("restored", "neovim");
      await fixture.start(restored);
      const offset = fixture.events(restored.label).length;
      fixture.command(restored, `/resume ${seed.id}`);
      await fixture.screenHas(restored, "Resume conversation");
      fixture.keys(restored, "Enter");
      const current = await fixture.start(restored, offset);
      assert.equal(current.id, seed.id);
      assert.notEqual(current.pid, original.pid);
      fixture.owned(current);
      assert.equal(fs.readFileSync(seed.file, "utf8"), before);
    } finally {
      await fixture.close();
    }
  },
);
