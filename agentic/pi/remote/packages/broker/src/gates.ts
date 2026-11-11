import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.ts";
export const REQUIRED = [
  "automated",
  "session-controls-tui",
  "iphone-pairing",
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
    "extensions/_remote_bridge",
    "extensions/_tool-display",
    "extensions/_working-status",
    "extensions/thinking-status",
    "extensions/mcp-collapse/display.ts",
    "extensions/skill/types.ts",
    "extensions/subagent/display.ts",
    "extensions/subagent/session-label.ts",
    "extensions/remote-control",
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
const PilotApproval = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.string().url(),
    dataDir: z.string(),
    scope: z.enum(["fresh-managed-only", "laptop-main"]),
    agentDir: z.string(),
    sessionDirectories: z.array(z.string()),
    at: z.number().int().positive(),
    evidence: z.string(),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    deferred: z.array(z.string()),
  })
  .strict();

export function approvePilot(config: Config, evidenceFile: string) {
  if (config.deploymentPolicy !== "pilot") throw new Error("Pilot policy required");
  const evidence = fs.realpathSync(evidenceFile);
  if (!fs.statSync(evidence).isFile()) throw new Error("Evidence file required");
  const report = gates(config);
  const approval = PilotApproval.parse({
    version: 1,
    digest: report.digest,
    origin: config.origin,
    dataDir: fs.realpathSync(config.dataDir),
    scope: config.pilotScope,
    agentDir: fs.realpathSync(config.agentDir),
    sessionDirectories: config.sessionDirectories
      .map((dir) => fs.realpathSync(dir))
      .sort(),
    at: Date.now(),
    evidence,
    evidenceHash: createHash("sha256").update(fs.readFileSync(evidence)).digest("hex"),
    deferred: ["native-exit-investigation", "sleep-wake", "reboot"],
  });
  fs.writeFileSync(
    path.join(config.dataDir, "pilot-approval.json"),
    JSON.stringify(approval, null, 2),
    { mode: 0o600 },
  );
}

export function deployment(
  config: Config,
  proof = false,
): Omit<ReturnType<typeof gates>, "missing"> & {
  policy: Config["deploymentPolicy"];
  missing: string[];
} {
  const report = gates(config);
  if (config.deploymentPolicy !== "pilot")
    return {
      ...report,
      policy: "release" as const,
      missing: report.missing.filter((name) => !proof || name === "automated"),
    };
  let approved = false;
  try {
    const approval = PilotApproval.parse(
      JSON.parse(
        fs.readFileSync(path.join(config.dataDir, "pilot-approval.json"), "utf8"),
      ),
    );
    approved =
      approval.digest === report.digest &&
      approval.origin === config.origin &&
      approval.scope === config.pilotScope &&
      approval.agentDir === fs.realpathSync(config.agentDir) &&
      JSON.stringify(approval.sessionDirectories) ===
        JSON.stringify(
          config.sessionDirectories.map((dir) => fs.realpathSync(dir)).sort(),
        ) &&
      approval.dataDir === fs.realpathSync(config.dataDir) &&
      approval.evidenceHash ===
        createHash("sha256").update(fs.readFileSync(approval.evidence)).digest("hex");
  } catch {}
  return {
    ...report,
    policy: "pilot" as const,
    missing: [
      ...report.missing.filter(
        (name) => name === "automated" || name === "session-controls-tui",
      ),
      ...(!approved ? ["pilot-approval"] : []),
      ...(proof ? ["pilot-proof-conflict"] : []),
    ],
  };
}

export function assertDeployment(config: Config, proof = false) {
  const report = deployment(config, proof);
  if (report.missing.length)
    throw new Error(
      `Deployment blocked; missing current evidence: ${report.missing.join(", ")}`,
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
