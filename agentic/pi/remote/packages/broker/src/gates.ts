import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const REQUIRED = [
  "automated",
  "ownership-tui",
  "iphone-webauthn",
  "iphone-push",
  "sleep-wake",
  "tailnet-acl",
] as const;
export function sourceDigest(root: string) {
  const hash = createHash("sha256");
  function add(file: string) {
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (
          ["node_modules", "dist", "test-results", "playwright-report"].includes(name)
        )
          continue;
        add(path.join(file, name));
      }
    } else {
      hash.update(path.relative(root, file));
      hash.update(fs.readFileSync(file));
    }
  }
  for (const name of [
    "remote/packages",
    "remote/scripts",
    "remote/package.json",
    "remote/package-lock.json",
    "profile",
    "bin/pi",
    "bin/pi-remote",
    "agents/main.md",
    "extensions/_session_ownership",
    "extensions/_remote_bridge",
    "extensions/remote-control",
    "extensions/session-ownership",
    "extensions/question/index.ts",
    "extensions/git-worktree-isolation/index.ts",
    "extensions/git-worktree-isolation/git.ts",
    "extensions/_voice-input/ptt.ts",
    "extensions/conversation-name",
    "extensions/caffeinate",
    "extensions/vm-isolation",
    "extensions/incognito",
    "extensions/_incognito_state",
    "extensions/_interactive_queue",
    "extensions/_loop_state",
    "extensions/loop",
    "extensions/fast",
    "extensions/context-limit",
    "extensions/subagent/index.ts",
    "extensions/web-browse",
    "extensions/splash/index.ts",
  ])
    add(path.join(root, name));
  hash.update("installed-pi-runtime");
  hash.update(fs.readFileSync(path.join(resolvePiPackage(), "package.json")));
  return hash.digest("hex");
}
export function gates(config: { dataDir: string; agentDir: string }) {
  const file = path.join(config.dataDir, "release-gates.json");
  let evidence: Record<string, { digest: string; at: number; evidence: string }> = {};
  try {
    evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const digest = sourceDigest(fs.realpathSync(config.agentDir));
  return {
    digest,
    evidence,
    missing: REQUIRED.filter((name) => evidence[name]?.digest !== digest),
  };
}
export function attest(
  config: { dataDir: string; agentDir: string },
  name: string,
  evidenceFile: string,
) {
  if (!REQUIRED.includes(name as (typeof REQUIRED)[number]))
    throw new Error("Unknown release gate");
  const evidence = fs.realpathSync(evidenceFile);
  if (!fs.statSync(evidence).isFile()) throw new Error("Evidence file required");
  const report = gates(config);
  report.evidence[name] = { digest: report.digest, at: Date.now(), evidence };
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(config.dataDir, "release-gates.json"),
    JSON.stringify(report.evidence, null, 2),
    { mode: 0o600 },
  );
}
export function assertRelease(
  config: { dataDir: string; agentDir: string },
  proof = false,
) {
  const missing = gates(config).missing.filter(
    (name) => !proof || name === "automated",
  );
  if (missing.length)
    throw new Error(
      `Deployment blocked; missing current evidence: ${missing.join(", ")}`,
    );
}
