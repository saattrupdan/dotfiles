import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
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
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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
  if (
    historyInScope(session.sessionFile, path.join(config.agentDir, "profile-sessions"))
  )
    return false;
  if (config.deploymentPolicy !== "pilot") return true;
  if (config.pilotScope === "laptop-main")
    return mainHistory(config, session.sessionFile);
  return (
    !!session.managed &&
    !!session.tmux &&
    historyInScope(session.sessionFile, path.join(config.dataDir, "native-sessions"))
  );
}

function smallFile(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid worktree metadata");
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > stat.size) throw new Error("Worktree metadata changed while reading");
    return buffer.subarray(0, size).toString("utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
}

/** Map only a verified managed worktree to its ordinary project for listing and scope. */
export function registeredWorkingDirectory(
  config: Config,
  cwd: string,
): { cwd: string; runtimeCwd?: string } | undefined {
  if (visibleWorkingDirectory(config, cwd)) return { cwd };
  try {
    const base = canonicalPath(path.join(config.agentDir, "worktrees")),
      actual = canonicalPath(cwd);
    const relative = path.relative(base, actual),
      parts = relative.split(path.sep);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      parts.length < 2 ||
      !/^[-a-z0-9]+$/.test(parts[1]!)
    )
      return;
    const worktree = path.join(base, parts[0]!, parts[1]!);
    const pointer = smallFile(path.join(worktree, ".git"));
    if (!pointer.startsWith("gitdir: ")) return;
    const gitdir = canonicalPath(path.resolve(worktree, pointer.slice(8)));
    const common = path.dirname(path.dirname(gitdir));
    if (
      path.basename(path.dirname(gitdir)) !== "worktrees" ||
      path.basename(common) !== ".git" ||
      !visibleWorkingDirectory(config, path.dirname(common))
    )
      return;
    if (
      canonicalPath(path.resolve(gitdir, smallFile(path.join(gitdir, "commondir")))) !==
      common
    )
      return;
    if (
      canonicalPath(smallFile(path.join(gitdir, "gitdir"))) !==
      canonicalPath(path.join(worktree, ".git"))
    )
      return;
    if (createHash("sha256").update(common).digest("hex").slice(0, 12) !== parts[0])
      return;
    const manifestPath = path.join(common, "pi-worktree-sessions", parts[1] + ".json");
    const manifest = JSON.parse(smallFile(manifestPath));
    if (
      manifest.version !== 1 ||
      manifest.id !== parts[1] ||
      canonicalPath(manifest.worktreeRoot) !== worktree ||
      canonicalPath(manifest.commonGitDir) !== common ||
      canonicalPath(manifest.repoRoot) !== path.dirname(common) ||
      canonicalPath(manifest.manifestPath) !== manifestPath ||
      canonicalPath(manifest.agentDir ?? config.agentDir) !==
        canonicalPath(config.agentDir)
    )
      return;
    const project = manifest.sessionHubCwd ?? manifest.repoRoot;
    if (canonicalPath(project) !== path.dirname(common)) return;
    const logical = path.join(project, ...parts.slice(2));
    if (!visibleWorkingDirectory(config, logical)) return;
    return { cwd: logical, runtimeCwd: cwd };
  } catch {
    return;
  }
}
