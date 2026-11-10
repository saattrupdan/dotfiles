import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TuiFixture, waitFor, type Pane } from "./tui-fixture.ts";
import { ConfigSchema } from "../src/config.ts";
import { createBroker } from "../src/server.ts";

for (const mode of ["terminal", "neovim"] as const) {
  test(
    `native ${mode}: resume, cancellation, reload, fork and new work without a broker`,
    { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 120000 },
    async () => {
      const fixture = new TuiFixture();
      let pane: Pane | undefined;
      try {
        const seed = await fixture.seed("resume-fixture");
        pane = await fixture.launch(mode, mode);
        const first = await fixture.start(pane);
        let offset = fixture.events(pane.label).length;
        fixture.command(pane, "/reload");
        const reloaded = await fixture.start(pane, offset);
        assert.equal(reloaded.id, first.id);
        assert.equal(reloaded.pid, first.pid);

        fixture.command(pane, "/resume");
        await fixture.screenHas(pane, "Resume Session");
        fixture.keys(pane, "Escape");
        await waitFor(() => !fixture.screen(pane!).includes("Resume Session"), "resume picker closes");
        assert.equal(fixture.latest(pane)!.id, first.id);
        fs.writeFileSync(fixture.env.PI_PROOF_CANCEL!, "cancel");
        offset = fixture.events(pane.label).length;
        fixture.command(pane, "/resume");
        await fixture.screenHas(pane, "Resume Session");
        fixture.keys(pane, "Enter");
        await waitFor(
          () => fixture.events(pane!.label).slice(offset).find((e) => e.kind === "cancel_switch"),
          "native switch cancellation",
        );
        await waitFor(() => !fixture.screen(pane!).includes("Resume Session"), "cancelled switch closes picker");
        assert.equal(fixture.latest(pane)!.id, first.id);
        fs.unlinkSync(fixture.env.PI_PROOF_CANCEL!);

        offset = fixture.events(pane.label).length;
        fixture.command(pane, "/resume");
        await fixture.screenHas(pane, "Resume Session");
        fixture.keys(pane, "Enter");
        const resumed = await fixture.start(pane, offset);
        assert.equal(resumed.id, seed.id);
        assert.equal(resumed.pid, first.pid);

        offset = fixture.events(pane.label).length;
        fixture.command(pane, "/fork");
        await fixture.screenHas(pane, "Fork from Message");
        fixture.keys(pane, "Enter");
        const forked = await fixture.start(pane, offset);
        assert.notEqual(forked.id, resumed.id);
        fixture.keys(pane, "C-u");

        offset = fixture.events(pane.label).length;
        fixture.command(pane, "/new");
        const fresh = await fixture.start(pane, offset);
        assert.notEqual(fresh.id, forked.id);
        fixture.keys(pane, "C-r");
        await fixture.screenHas(pane, "Resume Session");
        fixture.keys(pane, "Escape");
        await waitFor(() => !fixture.screen(pane!).includes("Resume Session"), "shortcut picker closes");
        offset = fixture.events(pane.label).length;
        fixture.keys(pane, "C-n");
        const keyed = await fixture.start(pane, offset);
        assert.notEqual(keyed.id, fresh.id);
        assert(!fixture.events().some((e) => e.kind === "unexpected_input"));
        assert.equal(fs.existsSync(fixture.data + "/broker.sock"), false);
      } catch (error) {
        if (pane) console.error(fixture.screen(pane), JSON.stringify(fixture.events(pane.label)));
        throw error;
      } finally {
        await fixture.close();
      }
    },
  );
}

test(
  "remote registration follows native new and resume without session locks",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture();
    const config = ConfigSchema.parse({ origin: "https://fixture.test.ts.net", home: fixture.root,
      agentDir: fixture.agent, dataDir: fixture.data, deploymentPolicy: "pilot", pilotScope: "laptop-main" });
    const broker = await createBroker(config, { history: false });
    let pane: Pane | undefined;
    try {
      const seed = await fixture.seed("remote-resume");
      pane = await fixture.launch("remote");
      const first = await fixture.start(pane);
      const connected = async (id: string) => waitFor(() => {
        const session = broker.store.session(id);
        return session && broker.connections.isConnected(session) ? session : undefined;
      }, "native session registers remotely");
      const initial = await connected(first.id);
      const offset = fixture.events(pane.label).length;
      fixture.command(pane, "/new");
      const fresh = await fixture.start(pane, offset);
      const current = await connected(fresh.id);
      assert.equal(current.pid, initial.pid);
      assert.equal(broker.connections.isConnected(initial), false);
      fixture.command(pane, "/resume");
      await fixture.screenHas(pane, "Resume Session");
      fixture.keys(pane, "Enter");
      const resumed = await connected(seed.id);
      assert.equal(resumed.pid, initial.pid);
      assert.equal(broker.connections.isConnected(current), false);
      assert.equal(fs.existsSync(fixture.data + "/ownership"), false);
    } catch (error) {
      if (pane) console.error(fixture.screen(pane));
      throw error;
    } finally {
      await fixture.close();
      await broker.app.close();
    }
  },
);

test(
  "native resume discovers a custom session directory",
  { skip: process.env.PI_REMOTE_TUI_PROOF !== "1", timeout: 60000 },
  async () => {
    const fixture = new TuiFixture(true);
    let pane: Pane | undefined;
    try {
      const seed = await fixture.seed("custom-directory");
      pane = await fixture.launch("custom");
      await fixture.start(pane);
      const offset = fixture.events(pane.label).length;
      fixture.command(pane, "/resume");
      await fixture.screenHas(pane, "Resume Session");
      fixture.keys(pane, "Tab");
      await fixture.screenHas(pane, "Resume Session (All)");
      fixture.keys(pane, "Tab", "Enter");
      const resumed = await fixture.start(pane, offset);
      assert.equal(resumed.id, seed.id);
    } catch (error) {
      if (pane) console.error(fixture.screen(pane));
      throw error;
    } finally {
      await fixture.close();
    }
  },
);
