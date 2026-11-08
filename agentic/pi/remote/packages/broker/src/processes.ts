import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { Owners } from "./ipc.ts";
import { homeDirectory } from "./files.ts";
export class Processes {
  shells = new Map<string, number>();
  constructor(
    readonly config: Config,
    readonly owners: Owners,
  ) {}
  tmux(...args: string[]) {
    return execFileSync(this.config.tmux, args, { encoding: "utf8", timeout: 10000 });
  }
  async launch(cwd: string, saved?: { id: string; path: string }) {
    cwd = homeDirectory(cwd, this.config.home);
    const id = saved?.id ?? randomUUID();
    const name = `pi-remote-${randomUUID()}`;
    const launches = path.join(this.config.dataDir, "launches");
    fs.mkdirSync(launches, { recursive: true, mode: 0o700 });
    const launchId = randomUUID();
    const file = path.join(launches, `${launchId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        id,
        cwd,
        sessionFile: saved?.path,
        tmux: name,
        created: Date.now(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    this.tmux("new-session", "-d", "-s", name, "-c", cwd);
    this.tmux("set-option", "-t", name, "@pi_agent", launchId);
    this.tmux("set-option", "-t", name, "@pi_remote", id);
    const pid = this.tmux(
      "display-message",
      "-pt",
      `${name}:0.0`,
      "#{pane_pid}",
    ).trim();
    const shell = execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" })
      .trim()
      .split("/")
      .pop()
      ?.replace(/^-/, "");
    if (!shell || !["zsh", "bash", "sh", "fish"].includes(shell))
      throw new Error("tmux shell verification failed");
    const compiled = fileURLToPath(new URL("./run-managed.mjs", import.meta.url));
    const shim = fs.existsSync(compiled)
      ? compiled
      : fileURLToPath(new URL("./run-managed.ts", import.meta.url));
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const line = [
      this.config.node,
      ...(fs.existsSync(compiled) ? [] : ["--import", import.meta.resolve("tsx")]),
      shim,
      this.config.dataDir,
      launchId,
    ]
      .map(quote)
      .join(" ");
    this.tmux("send-keys", "-t", `${name}:0.0`, "-l", line);
    this.tmux("send-keys", "-t", `${name}:0.0`, "Enter");
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const session = this.owners.store.session(id);
      if (session && this.owners.isConnected(session)) return session;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      "Pi did not register with required ownership/remote guards; inspect managed tmux session",
    );
  }
  reapIdleShells() {
    let sessions: string;
    try {
      sessions = this.tmux(
        "list-sessions",
        "-F",
        "#{session_name} #{@pi_remote} #{session_attached} #{@pi_agent}",
      );
    } catch {
      return;
    }
    for (const line of sessions.trim().split("\n")) {
      const [name, id, attached, marker] = line.split(" ");
      if (!name?.startsWith("pi-remote-") || !id || attached !== "0" || !marker)
        continue;
      try {
        const panes = this.tmux(
          "list-panes",
          "-s",
          "-t",
          name,
          "-F",
          "#{pane_pid} #{pane_current_command}",
        )
          .trim()
          .split("\n");
        let idle = panes.length > 0;
        for (const pane of panes) {
          const [pid, foreground] = pane.trim().split(/\s+/);
          const proc = execFileSync(
            "ps",
            ["-p", pid!, "-o", "pgid=", "-o", "tpgid=", "-o", "comm="],
            { encoding: "utf8" },
          )
            .trim()
            .split(/\s+/);
          const shell = path.basename(proc[2] || "").replace(/^-/, "");
          if (
            ![
              "sh",
              "bash",
              "zsh",
              "fish",
              "dash",
              "ksh",
              "mksh",
              "tcsh",
              "csh",
              "nu",
            ].includes(shell) ||
            foreground !== shell ||
            proc[0] !== proc[1]
          ) {
            idle = false;
            break;
          }
          try {
            execFileSync("pgrep", ["-P", pid!], { stdio: "ignore" });
            idle = false;
            break;
          } catch (error) {
            if ((error as { status?: number }).status !== 1) {
              idle = false;
              break;
            }
          }
        }
        if (!idle) {
          this.shells.delete(name);
          continue;
        }
        const since = this.shells.get(name) ?? Date.now();
        this.shells.set(name, since);
        if (Date.now() - since > 60000) {
          if (
            this.tmux("show-option", "-qv", "-t", name, "@pi_agent").trim() === marker
          )
            this.tmux("kill-session", "-t", name);
          this.shells.delete(name);
        }
      } catch {
        this.shells.delete(name);
      }
    }
  }
}
