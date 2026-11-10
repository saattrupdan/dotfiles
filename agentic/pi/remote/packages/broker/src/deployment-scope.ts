import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.ts";
/** The expanded pilot admits main histories without admitting private profiles. */
export function sessionRoots(config: Config) {
  return [
    path.join(config.agentDir, "sessions"),
    path.join(config.dataDir, "native-sessions"),
    ...config.sessionDirectories,
  ];
}

function historyInScope(file: string, root: string) {
  const relative = path.relative(canonicalPath(root), canonicalPath(file));
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function mainHistory(config: Config, file: string) {
  return (
    !historyInScope(file, path.join(config.agentDir, "profile-sessions")) &&
    sessionRoots(config).some((root) => historyInScope(file, root))
  );
}
const directoryRoots = new WeakMap<Config, { stamp: number; roots: string[] }>();
export function canonicalPath(input: string): string {
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
      canonicalPath(config.agentDir),
    ]);
    for (const name of fs.existsSync(config.agentDir)
      ? fs.readdirSync(config.agentDir)
      : []) {
      const child = path.join(config.agentDir, name);
      try {
        if (fs.statSync(child).isDirectory()) roots.add(canonicalPath(child));
      } catch {
        /* Broken resource links cannot reveal conversations. */
      }
    }
    cached = { stamp, roots: [...roots] };
    directoryRoots.set(config, cached);
  }
  return !cached.roots.some((root) =>
    [path.resolve(cwd), canonicalPath(cwd)].some((target) => {
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
  if (historyInScope(session.sessionFile, path.join(config.agentDir, "profile-sessions"))) return false;
  if (config.deploymentPolicy !== "pilot") return true;
  if (config.pilotScope === "laptop-main")
    return mainHistory(config, session.sessionFile);
  return (
    !!session.managed &&
    !!session.tmux &&
    historyInScope(session.sessionFile, path.join(config.dataDir, "native-sessions"))
  );
}
