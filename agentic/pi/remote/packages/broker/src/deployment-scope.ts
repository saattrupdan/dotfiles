import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { RemoteError } from "../../protocol/src/index.ts";
import {
  historyInScope,
  laptopActivated,
  pendingMigration,
} from "../../../../extensions/_session_ownership/ownership.mjs";

export function controlBlockReason(config: Config) {
  const root = path.join(config.dataDir, "ownership");
  if (
    config.deploymentPolicy === "pilot" &&
    config.pilotScope === "laptop-main" &&
    !laptopActivated(root)
  )
    return "laptop_activation_required";
  if (pendingMigration(root)) return "laptop_restart_required";
  return undefined;
}
export function assertControlReady(config: Config) {
  const reason = controlBlockReason(config);
  if (reason) throw new RemoteError(reason, 409);
}

/** The expanded pilot admits main histories without admitting private profiles. */
export function sessionRoots(config: Config) {
  return [
    path.join(config.agentDir, "sessions"),
    path.join(config.dataDir, "native-sessions"),
    ...config.sessionDirectories,
  ];
}

export function mainHistory(config: Config, file: string) {
  return (
    !historyInScope(file, path.join(config.agentDir, "profile-sessions")) &&
    sessionRoots(config).some((root) => historyInScope(file, root))
  );
}
const directoryRoots = new WeakMap<Config, { stamp: number; roots: string[] }>();
function canonicalDirectory(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  while (!fs.existsSync(current) && path.dirname(current) !== current) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  try {
    return path.join(fs.realpathSync(current), ...suffix);
  } catch {
    return path.resolve(input);
  }
}
export function visibleWorkingDirectory(config: Config, cwd: string) {
  const stamp = fs.statSync(config.agentDir, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  let cached = directoryRoots.get(config);
  if (!cached || cached.stamp !== stamp) {
    const roots = new Set([
      path.resolve(config.agentDir),
      canonicalDirectory(config.agentDir),
    ]);
    for (const name of fs.existsSync(config.agentDir)
      ? fs.readdirSync(config.agentDir)
      : []) {
      const child = path.join(config.agentDir, name);
      try {
        if (fs.statSync(child).isDirectory()) roots.add(canonicalDirectory(child));
      } catch {
        /* Broken resource links cannot reveal conversations. */
      }
    }
    cached = { stamp, roots: [...roots] };
    directoryRoots.set(config, cached);
  }
  return !cached.roots.some((root) =>
    [path.resolve(cwd), canonicalDirectory(cwd)].some((target) => {
      const relative = path.relative(root, target);
      return (
        !relative ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    }),
  );
}
export function inDeploymentScope(
  config: Config,
  session: { managed: boolean; tmux?: string; sessionFile: string; cwd?: string },
) {
  if (session.cwd && !visibleWorkingDirectory(config, session.cwd)) return false;
  if (config.deploymentPolicy !== "pilot") return true;
  if (config.pilotScope === "laptop-main")
    return mainHistory(config, session.sessionFile);
  return (
    !!session.managed &&
    !!session.tmux &&
    historyInScope(session.sessionFile, path.join(config.dataDir, "native-sessions"))
  );
}
