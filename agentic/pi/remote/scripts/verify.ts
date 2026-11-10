import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../packages/broker/src/config.ts";
import { attest, sourceDigest } from "../packages/broker/src/gates.ts";
const remote = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pi = path.dirname(remote);
const npm = path.join(path.dirname(process.execPath), "npm");
const commands = [
  { cwd: remote, bin: npm, args: ["run", "check"] },
  { cwd: remote, bin: npm, args: ["test"] },
  { cwd: remote, bin: npm, args: ["run", "build"] },
  {
    cwd: path.join(pi, "extensions"),
    bin: "./node_modules/.bin/tsc",
    args: ["-p", "tsconfig.json", "--noEmit"],
  },
  { cwd: path.join(pi, "extensions"), bin: "./node_modules/.bin/eslint", args: ["."] },
  { cwd: path.join(pi, "extensions"), bin: npm, args: ["test"] },
  {
    cwd: pi,
    bin: process.execPath,
    args: [
      "--test",
      "profile/profile.test.mjs",
      "profile/session-selection.test.mjs",
      "profile/saved-sessions.test.mjs",
      "extensions/_session_ownership/ownership.test.mjs",
    ],
  },
];
for (const c of commands) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "npm_config_prefix",
    ),
  );
  const result = spawnSync(c.bin, c.args, { cwd: c.cwd, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const file = process.argv[2];
if (file) {
  const config = loadConfig(file);
  const evidence = path.join(config.dataDir, "automated-evidence.json");
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    evidence,
    JSON.stringify({ at: Date.now(), digest: sourceDigest(pi), commands }, null, 2),
    { mode: 0o600 },
  );
  attest(config, "automated", evidence);
} else
  console.log(
    "Automated checks passed. Supply a config path to record release evidence.",
  );
