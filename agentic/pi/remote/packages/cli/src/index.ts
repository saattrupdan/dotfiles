import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import qr from "qrcode-terminal";
import {
  loadConfig,
  ConfigSchema,
  prepare,
  type Config,
} from "../../broker/src/config.ts";
import { localRequest } from "../../broker/src/ipc.ts";
import {
  assertDeployment,
  approvePilot,
  attest,
  deployment,
  gates,
} from "../../broker/src/gates.ts";

const args = process.argv.slice(2);
const command = args.shift() ?? "status";
const flag = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const configFile = path.resolve(
  flag("--config") ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "PiRemote",
      "config.json",
    ),
);
const proof = args.includes("--proof");
const label = "com.saattrupdan.pi-remote";
function run(file: string, argv: string[]) {
  return execFileSync(file, argv, { encoding: "utf8", timeout: 30000 });
}
function untracked(config: Config) {
  const locks = path.join(config.dataDir, "ownership", "locks.sqlite");
  let tracked = new Set<number>();
  if (fs.existsSync(locks)) {
    const db = new DatabaseSync(locks, { readOnly: true });
    try {
      tracked = new Set(
        db
          .prepare("SELECT record FROM locks")
          .all()
          .map((row) => JSON.parse(row.record as string).pid),
      );
    } finally {
      db.close();
    }
  }
  return run("ps", ["-axo", "pid=,comm="])
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      return m && path.basename(m[2]!) === "pi" && !tracked.has(Number(m[1]))
        ? [Number(m[1])]
        : [];
    });
}
const launchFile = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function plist(config: Config, release: string) {
  const log = path.join(os.homedir(), "Library", "Logs", "PiRemote");
  fs.mkdirSync(log, { recursive: true, mode: 0o700 });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[config.node, path.join(release, "broker.mjs"), "--config", configFile].map((x) => `<string>${escape(x)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>WorkingDirectory</key><string>${escape(release)}</string><key>Umask</key><integer>63</integer><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(os.homedir())}</string><key>PATH</key><string>${escape(path.dirname(config.node))}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict><key>StandardOutPath</key><string>${escape(path.join(log, "broker.log"))}</string><key>StandardErrorPath</key><string>${escape(path.join(log, "broker-error.log"))}</string></dict></plist>\n`;
}
function stop() {
  try {
    run("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`]);
  } catch {
    /* A not-yet-installed broker has nothing to stop. */
  }
}
function start(config: Config, release: string) {
  fs.mkdirSync(path.dirname(launchFile), { recursive: true });
  fs.writeFileSync(launchFile, plist(config, release), { mode: 0o600 });
  run("plutil", ["-lint", launchFile]);
  run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, launchFile]);
}
function backup(config: Config) {
  const file = path.join(config.dataDir, "broker.sqlite");
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(file, path.join(config.dataDir, `broker-${Date.now()}.sqlite.bak`));
  } finally {
    db.close();
  }
}
async function stage(config: Config) {
  const root = path.join(fs.realpathSync(config.agentDir), "remote");
  const result = spawnSync(
    path.join(path.dirname(config.node), "npm"),
    ["run", "build"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Build failed");
  const release = path.join(config.dataDir, "releases", String(Date.now()));
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(root, "dist"), release, { recursive: true });
  for (const name of ["package.json", "package-lock.json"])
    fs.copyFileSync(path.join(root, name), path.join(release, name));
  for (const name of ["broker", "cli", "protocol", "web"]) {
    const dir = path.join(release, "packages", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.join(root, "packages", name, "package.json"),
      path.join(dir, "package.json"),
    );
  }
  const install = spawnSync(
    path.join(path.dirname(config.node), "npm"),
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: release, stdio: "inherit" },
  );
  if (install.status !== 0)
    throw new Error("Pinned release dependencies failed to install");
  fs.writeFileSync(
    path.join(release, "release.json"),
    JSON.stringify({ digest: gates(config).digest, protocol: 1, created: Date.now() }),
    { mode: 0o600 },
  );
  return release;
}
async function main() {
  process.umask(0o077);
  if (command === "init") {
    const origin = flag("--origin");
    if (!origin)
      throw new Error("Usage: pi-remote init --origin https://MAC.TAILNET.ts.net");
    const config = ConfigSchema.parse({ origin });
    prepare(config);
    if (fs.existsSync(configFile)) throw new Error("Config already exists");
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(`Created ${configFile}; no service installed.`);
    return;
  }
  const config = loadConfig(configFile);
  if (proof && config.deploymentPolicy === "pilot")
    throw new Error("Pilot cannot use proof mode");
  if (command === "approve-pilot") {
    const evidence = flag("--evidence");
    if (!evidence) throw new Error("Usage: approve-pilot --evidence FILE");
    approvePilot(config, evidence);
    console.log(
      "Pilot approved for current sources and fresh managed conversations; full-release gates unchanged.",
    );
    return;
  }
  if (command === "attest") {
    const name = args.shift();
    const evidence = flag("--evidence");
    if (!name || !evidence) throw new Error("Usage: attest GATE --evidence FILE");
    attest(config, name, evidence);
    console.log(`Recorded ${name} evidence for the current sources.`);
    return;
  }
  if (command === "doctor") {
    const report = gates(config);
    const readiness = deployment(config);
    const old = untracked(config);
    const checks = {
      node: process.version,
      wrapper: fs.existsSync(path.join(config.agentDir, "bin", "pi")),
      tmux: fs.existsSync(config.tmux),
      build: fs.existsSync(path.join(config.agentDir, "remote", "dist", "broker.mjs")),
      deploymentPolicy: config.deploymentPolicy,
      deploymentMissing: readiness.missing,
      missingGates: report.missing,
      untrackedPiProcesses: old,
      origin: config.origin,
    };
    console.log(JSON.stringify(checks, null, 2));
    if (
      readiness.missing.length ||
      (config.deploymentPolicy === "release" && old.length)
    )
      process.exitCode = 1;
    return;
  }
  if (command === "install" || command === "update") {
    assertDeployment(config);
    const old = untracked(config);
    if (
      config.deploymentPolicy === "pilot" &&
      fs.existsSync(path.join(config.dataDir, "ownership", "enabled"))
    )
      throw new Error("Pilot cannot replace globally enabled ownership");
    if (command === "install" && old.length && config.deploymentPolicy === "release")
      throw new Error(
        `Restart/exit unprotected Pi processes before enabling ownership: ${old.join(", ")}`,
      );
    const release = await stage(config);
    const current = path.join(config.dataDir, "current");
    const previous = fs.existsSync(current) ? fs.realpathSync(current) : undefined;
    stop();
    backup(config);
    if (previous)
      fs.writeFileSync(path.join(config.dataDir, "previous"), previous, {
        mode: 0o600,
      });
    fs.rmSync(current, { force: true });
    fs.symlinkSync(release, current, "dir");
    fs.mkdirSync(path.join(config.dataDir, "ownership"), {
      recursive: true,
      mode: 0o700,
    });
    if (config.deploymentPolicy === "release")
      fs.writeFileSync(path.join(config.dataDir, "ownership", "enabled"), "1", {
        mode: 0o600,
      });
    start(config, release);
    console.log(
      `Installed ${release}. Pi owners were preserved. Configure private Tailscale Serve only after the ACL/HTTPS gate passes.`,
    );
    return;
  }
  if (command === "rollback") {
    assertDeployment(config);
    const previous = fs
      .readFileSync(path.join(config.dataDir, "previous"), "utf8")
      .trim();
    const releases = fs.realpathSync(path.join(config.dataDir, "releases"));
    if (!previous.startsWith(releases + path.sep))
      throw new Error("Invalid rollback release");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(previous, "release.json"), "utf8"),
    );
    if (manifest.protocol !== 1) throw new Error("Incompatible rollback protocol");
    stop();
    backup(config);
    const current = path.join(config.dataDir, "current");
    const old = fs.realpathSync(current);
    fs.rmSync(current);
    fs.symlinkSync(previous, current, "dir");
    fs.writeFileSync(path.join(config.dataDir, "previous"), old, { mode: 0o600 });
    start(config, previous);
    console.log("Previous broker restored; native histories and Pi owners untouched.");
    return;
  }
  if (command === "uninstall") {
    stop();
    fs.rmSync(launchFile, { force: true });
    console.log(
      "LaunchAgent removed. Ownership protection and saved data retained. Remove this service's Tailscale Serve mapping separately.",
    );
    return;
  }
  if (proof) config.dataDir = path.join(config.dataDir, "proof");
  if (command === "pair") {
    const result = (await localRequest(config, "pair")) as {
      url: string;
      expiresAt: number;
    };
    qr.generate(result.url, { small: true });
    console.log(result.url);
    console.log("One use; expires in 10 minutes.");
    return;
  }
  if (command === "devices" || command === "status") {
    console.log(JSON.stringify(await localRequest(config, command), null, 2));
    return;
  }
  if (command === "revoke") {
    console.log(JSON.stringify(await localRequest(config, "revoke", { id: args[0] })));
    return;
  }
  throw new Error(
    "Commands: init, doctor, install, uninstall, status, pair, devices, revoke, update, rollback, attest, approve-pilot",
  );
}
main().catch((error) => {
  console.error(`pi-remote: ${error.message}`);
  process.exitCode = 1;
});
