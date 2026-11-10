/** Fixed shim: launch only the main-profile wrapper from a private launch record. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { homeDirectory } from "./files.ts";
const dir = process.argv[2]!;
const id = z.string().uuid().parse(process.argv[3]);
const config = loadConfig(path.join(dir, "config.json"));
const file = path.join(config.dataDir, "launches", `${id}.json`);
const launch = z
  .object({
    id: z.string().uuid(),
    cwd: z.string(),
    sessionFile: z.string().optional(),
    tmux: z.string(),
    created: z.number(),
  })
  .parse(JSON.parse(fs.readFileSync(file, "utf8")));
if (Date.now() - launch.created > 120000) throw new Error("Launch expired");
fs.unlinkSync(file);
const cwd = homeDirectory(launch.cwd, config.home);
const args = launch.sessionFile
  ? ["--session", launch.sessionFile]
  : ["--session-id", launch.id];
const sessionDir =
  config.deploymentPolicy === "pilot" && config.pilotScope === "fresh-managed-only"
    ? path.join(config.dataDir, "native-sessions")
    : undefined;
if (sessionDir) fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (
    /^PI_(SUBAGENT_|PROFILE_|SESSION_)/.test(key) ||
    key === "PI_CODING_AGENT_SESSION_DIR"
  )
    delete environment[key];
const child = spawn(
  path.join(config.agentDir, "bin", "pi"),
  ["--agent", "main", ...args],
  {
    cwd,
    stdio: "inherit",
    env: {
      ...environment,
      PI_CODING_AGENT_DIR: config.agentDir,
      ...(sessionDir ? { PI_CODING_AGENT_SESSION_DIR: sessionDir } : {}),
      PI_REMOTE_MANAGED: launch.tmux,
      PI_REMOTE_DATA_DIR: config.dataDir,
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
