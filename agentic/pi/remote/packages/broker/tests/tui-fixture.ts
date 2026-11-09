/** Real terminal/Neovim adapters with disposable profile, history, locks and PTYs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
import {
  inspect,
  isAlive,
} from "../../../../extensions/_session_ownership/ownership.mjs";

export type ProofEvent = {
  label: string;
  kind: string;
  pid: number;
  birth: string;
  tool?: string;
  command?: string;
  call?: string;
  file: string;
  id: string;
  cwd: string;
  at: number;
};
export type Pane = {
  target: string;
  marker: string;
  label: string;
  mode: "terminal" | "neovim";
  socket: string;
};
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function waitFor<T>(
  read: () => T | undefined | false,
  description: string,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Ownership proof timed out: ${description}`);
}

export class TuiFixture {
  readonly root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-ownership-tui-")),
  );
  readonly source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  readonly agent = path.join(this.root, "agent");
  readonly data = path.join(this.root, "data");
  readonly locks = path.join(this.data, "ownership");
  readonly cwd = path.join(this.root, "workspace");
  readonly eventFile = path.join(this.root, "events.jsonl");
  readonly observer = path.join(this.root, "observer.ts");
  readonly panes: Pane[] = [];
  readonly env: Record<string, string>;
  private watcher: ReturnType<typeof setInterval>;
  private idle = new Map<string, number>();

  constructor(customSessions = false) {
    fs.mkdirSync(this.agent);
    fs.mkdirSync(this.cwd);
    fs.mkdirSync(this.data);
    const deployed = path.join(os.homedir(), ".pi", "agent");
    for (const directory of ["agents", "extensions", "skills", "themes", "prompts"]) {
      const resource =
        directory === "agents" || directory === "extensions"
          ? path.join(this.source, directory)
          : path.join(deployed, directory);
      if (fs.existsSync(resource))
        fs.symlinkSync(resource, path.join(this.agent, directory));
    }
    for (const name of ["auth.json", "models.json"]) {
      const file = path.join(deployed, name);
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(this.agent, name));
        fs.chmodSync(path.join(this.agent, name), 0o600);
      }
    }
    const settingsFile = path.join(deployed, "settings.json");
    const settings = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      : {};
    fs.writeFileSync(
      path.join(this.agent, "settings.json"),
      JSON.stringify({ ...settings, quietStartup: true, defaultThinkingLevel: "off" }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(this.agent, "keybindings.json"),
      JSON.stringify({
        "app.session.resume": "ctrl+r",
        "app.session.new": "ctrl+n",
        "app.session.fork": "ctrl+f",
      }),
    );
    fs.writeFileSync(
      this.observer,
      `import fs from 'node:fs';
export default function(pi){
 const log=(kind,ctx,extra={})=>fs.appendFileSync(process.env.PI_PROOF_EVENTS,JSON.stringify({label:process.env.PI_PROOF_LABEL,kind,pid:process.pid,birth:JSON.parse(process.env.PI_SESSION_OWNER).birth,file:ctx.sessionManager.getSessionFile(),id:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,at:Date.now(),...extra})+'\\n');
 pi.on('session_start',(_event,ctx)=>{log('start',ctx);ctx.ui.setStatus('ownership-proof','OWNERSHIP_PROOF_READY');});
 pi.on('input',(_event,ctx)=>{if(process.env.PI_PROOF_MODEL==='1')return;log('unexpected_input',ctx);return {action:'handled'};});
 pi.registerCommand('ownership-proof-ready',{handler:async(_args,ctx)=>{log('ready',ctx);}});
 pi.on('session_before_switch',(_event,ctx)=>{log('before_switch',ctx);if(fs.existsSync(process.env.PI_PROOF_CANCEL)){log('cancel_switch',ctx);return {cancel:true};}});
 pi.on('agent_settled',(_event,ctx)=>log('settled',ctx));
 pi.on('tool_execution_start',(event,ctx)=>log('tool_start',ctx,{tool:event.toolName,command:event.args?.command,call:event.toolCallId}));
 pi.on('tool_execution_end',(event,ctx)=>log(event.isError?'tool_error':'tool_end',ctx,{tool:event.toolName,call:event.toolCallId}));
 pi.on('session_before_fork',(_event,ctx)=>{log('before_fork',ctx);});
 pi.on('session_shutdown',async(_event,ctx)=>{log('shutdown',ctx);if(process.env.PI_PROOF_DELAY==='1'){log('shutdown_wait',ctx);await new Promise(r=>setTimeout(r,1500));pi.appendEntry('ownership-proof-last-write',{pid:process.pid});log('shutdown_written',ctx);}});
}`,
    );
    this.env = {
      PI_REMOTE_OWNERSHIP: "1",
      PI_CODING_AGENT_DIR: this.agent,
      PI_SESSION_LOCK_ROOT: this.locks,
      PI_REMOTE_DATA_DIR: this.data,
      PI_WORKTREE_ISOLATION_DISABLE: "1",
      PI_PROOF_EVENTS: this.eventFile,
      PI_PROOF_CANCEL: path.join(this.root, "cancel-switch"),
    };
    if (customSessions)
      this.env.PI_CODING_AGENT_SESSION_DIR = path.join(this.root, "custom-sessions");
    this.watcher = setInterval(() => this.reapIdle(), 5000);
  }
  tmux(...args: string[]) {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10000 });
  }
  events(label?: string): ProofEvent[] {
    return fs.existsSync(this.eventFile)
      ? fs
          .readFileSync(this.eventFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((event: ProofEvent) => !label || event.label === label)
      : [];
  }
  latest(pane: Pane) {
    return this.events(pane.label)
      .filter((e) => e.kind === "start")
      .at(-1);
  }
  screen(pane: Pane) {
    return this.tmux("capture-pane", "-pt", pane.target + ":0.0", "-S", "-100");
  }
  text(pane: Pane, text: string) {
    this.tmux("send-keys", "-t", pane.target + ":0.0", "-l", text);
  }
  keys(pane: Pane, ...keys: string[]) {
    this.tmux("send-keys", "-t", pane.target + ":0.0", ...keys);
  }
  command(pane: Pane, text: string) {
    this.text(pane, text);
    this.keys(pane, "Enter");
  }
  async screenHas(pane: Pane, text: string) {
    return waitFor(
      () => this.screen(pane).includes(text),
      `${pane.label} shows ${text}`,
      5000,
    );
  }
  async start(pane: Pane, after = 0) {
    const result = await waitFor(
      () =>
        this.events(pane.label)
          .slice(after)
          .find((e) => e.kind === "start"),
      `${pane.label} session_start`,
    );
    await new Promise((r) => setTimeout(r, 200));
    this.keys(pane, "C-u");
    this.command(pane, "/ownership-proof-ready");
    await waitFor(
      () =>
        this.events(pane.label)
          .slice(after)
          .find((e) => e.kind === "ready" && e.id === result.id),
      `${pane.label} accepts keyboard commands`,
    );
    return result;
  }
  sessionDir(cwd = this.cwd) {
    return (
      this.env.PI_CODING_AGENT_SESSION_DIR ||
      path.join(
        this.agent,
        "sessions",
        `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      )
    );
  }
  async seed(name: string, cwd = this.cwd) {
    const { SessionManager } = await import(
      pathToFileURL(path.join(resolvePiPackage(), "dist/core/session-manager.js")).href
    );
    const session = SessionManager.create(cwd, this.sessionDir(cwd));
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: `Synthetic ownership fixture ${name}` }],
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fixture complete." }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    session.appendSessionInfo(name);
    return {
      file: session.getSessionFile() as string,
      id: session.getSessionId() as string,
    };
  }
  async launch(
    label: string,
    mode: Pane["mode"] = "terminal",
    args: string[] = [],
    extra: Record<string, string> = {},
    cwd = this.cwd,
  ) {
    const target = this.tmux(
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}",
      "-s",
      `pi-remote-tui-${label}-${randomUUID()}`,
      "-x",
      "160",
      "-y",
      "48",
      "-c",
      cwd,
    ).trim();
    const pane: Pane = {
      target,
      marker: randomUUID(),
      label,
      mode,
      socket: path.join(this.root, `${label}.sock`),
    };
    this.panes.push(pane);
    this.tmux("set-option", "-t", target, "@pi_agent", pane.marker);
    const pid = this.tmux(
      "display-message",
      "-pt",
      target + ":0.0",
      "#{pane_pid}",
    ).trim();
    assert(
      ["zsh", "bash", "sh", "fish"].includes(
        path
          .basename(
            execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).trim(),
          )
          .replace(/^-/, ""),
      ),
    );
    const tty = this.tmux(
      "display-message",
      "-pt",
      target + ":0.0",
      "#{pane_tty}",
    ).trim();
    await waitFor(
      () =>
        execFileSync("stty", ["-f", tty, "-a"], { encoding: "utf8" }).includes(
          "-icanon",
        ),
      `${label} interactive shell ready`,
    );
    const cli = [
      path.join(this.source, "bin/pi"),
      "--extension",
      this.observer,
      "--thinking",
      "off",
      "--tui-mode",
      "regular",
      ...args,
    ];
    const env = { ...this.env, PI_PROOF_LABEL: label, ...extra };
    let command = cli.map(quote).join(" ");
    if (mode === "neovim") {
      const plugin = path.join(os.homedir(), ".local/share/nvim/lazy/pi-agent.nvim");
      assert(fs.existsSync(path.join(plugin, "lua/pi-agent/init.lua")));
      const wrapper = path.join(this.root, `${label}-pi`);
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${cli.map(quote).join(" ")} "$@"\n`, {
        mode: 0o700,
      });
      const lua = path.join(this.root, `${label}.lua`);
      fs.writeFileSync(
        lua,
        `vim.opt.rtp:prepend(${JSON.stringify(plugin)})\nrequire('pi-agent').setup({command=${JSON.stringify(wrapper)},keymap=false})\nvim.schedule(function()require('pi-agent').open()end)\n`,
      );
      command = ["nvim", "-u", "NONE", "-i", "NONE", "--listen", pane.socket, "-S", lua]
        .map(quote)
        .join(" ");
    }
    const line = [
      "env -u PI_SESSION_OWNER -u PI_SESSION_ID -u PI_REMOTE_MANAGED",
      ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
      command,
    ].join(" ");
    this.text(pane, line);
    this.keys(pane, "Enter");
    return pane;
  }
  owned(event: ProofEvent) {
    const record = inspect(event.file, this.locks);
    assert(record, `Missing lock for ${event.file}`);
    assert.equal(record.pid, event.pid);
    return record;
  }
  private reapIdle() {
    for (const pane of this.panes) {
      try {
        if (
          this.tmux("show-option", "-qv", "-t", pane.target, "@pi_agent").trim() !==
          pane.marker
        )
          continue;
        const attached = this.tmux(
          "display-message",
          "-pt",
          pane.target,
          "#{session_attached}",
        ).trim();
        const pid = this.tmux(
          "display-message",
          "-pt",
          pane.target,
          "#{pane_pid}",
        ).trim();
        const [pgid, tpgid, comm] = execFileSync(
          "ps",
          ["-p", pid, "-o", "pgid=", "-o", "tpgid=", "-o", "comm="],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\s+/);
        let children = true;
        try {
          execFileSync("pgrep", ["-P", pid], { stdio: "ignore" });
        } catch (error) {
          children = (error as { status: number }).status !== 1;
        }
        const idle =
          attached === "0" &&
          pgid === tpgid &&
          ["zsh", "bash", "sh", "fish"].includes(
            path.basename(comm || "").replace(/^-/, ""),
          ) &&
          !children;
        if (!idle) {
          this.idle.delete(pane.target);
          continue;
        }
        const since = this.idle.get(pane.target) || Date.now();
        this.idle.set(pane.target, since);
        if (Date.now() - since >= 60000) this.tmux("kill-session", "-t", pane.target);
      } catch {
        this.idle.delete(pane.target);
      }
    }
  }
  async close() {
    clearInterval(this.watcher);
    for (const pane of this.panes) {
      try {
        if (
          this.tmux("show-option", "-qv", "-t", pane.target, "@pi_agent").trim() !==
          pane.marker
        )
          continue;
        if (pane.mode === "neovim") {
          try {
            execFileSync(
              "nvim",
              ["--server", pane.socket, "--remote-expr", "execute('qa!')"],
              { stdio: "ignore", timeout: 5000 },
            );
          } catch {
            /* Server exited. */
          }
        } else {
          this.keys(pane, "Escape", "C-u");
          this.command(pane, "/quit");
        }
      } catch {
        /* Pane already exited. */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const pane of this.panes) {
      try {
        if (
          this.tmux("show-option", "-qv", "-t", pane.target, "@pi_agent").trim() ===
          pane.marker
        )
          this.tmux("kill-session", "-t", pane.target);
      } catch {
        /* Pane already exited. */
      }
    }
    // Wait for owned children to exit before removing their profile and lock files.
    await waitFor(
      () =>
        this.events().every((event) => {
          return !isAlive({
            pid: event.pid,
            birth: event.birth,
            instanceId: "proof",
            kind: "local",
          });
        }),
      "fixture Pi processes exit",
      10000,
    );
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
