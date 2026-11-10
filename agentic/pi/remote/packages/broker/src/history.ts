import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
import { Id, RemoteError, type SessionFolder } from "../../protocol/src/index.ts";
import { mainHistory, sessionRoots } from "./deployment-scope.ts";
import type { Config } from "./config.ts";

export const RECENT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_WINDOW_BYTES = 64 * 1024;
const HISTORY_BYTES = 128 * 1024 * 1024;
const RECENT_HISTORY_BYTES = 8 * 1024 * 1024;
interface NativeSession {
  path: string;
  id: string;
  nativeId: string;
  cwd: string;
  name?: string;
  modified: Date;
  ambiguous: boolean;
}
interface NativeEntry {
  type: string;
  id?: string;
  parentId?: string;
  [key: string]: unknown;
}
interface NativeModule {
  parseSessionEntries: (s: string) => NativeEntry[];
  buildSessionProjection: (
    entries: NativeEntry[],
    leaf?: string | null,
  ) => { messages: unknown[] };
}
function reference(file: string) {
  const bytes = createHash("sha256").update(file).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function stamp(stats: fs.Stats) {
  return `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}

/** Discovery reads bounded metadata; transcript projection occurs only on selection. */
export class History {
  module: Promise<NativeModule>;
  private headers = new Map<string, { stamp: string; row: NativeSession }>();
  private names = new Map<string, { stamp: string; name?: string }>();
  constructor(readonly config: Config) {
    this.module = import(
      pathToFileURL(path.join(resolvePiPackage(), "dist/core/session-manager.js")).href
    );
  }
  private files() {
    const files = new Set<string>(),
      directories = new Set<string>();
    const addFiles = (directory: string) => {
      const canonical = fs.realpathSync(directory);
      if (
        directories.has(canonical) ||
        !mainHistory(this.config, path.join(canonical, ".allocated"))
      )
        return;
      directories.add(canonical);
      for (const name of fs.readdirSync(canonical)) {
        if (!name.endsWith(".jsonl")) continue;
        try {
          const file = fs.realpathSync(path.join(canonical, name));
          if (mainHistory(this.config, file)) files.add(file);
        } catch {
          /* Concurrent removal cannot enter the index. */
        }
      }
    };
    for (const root of sessionRoots(this.config)) {
      if (!fs.existsSync(root)) continue;
      addFiles(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          const directory = path.join(root, entry.name);
          if (fs.statSync(directory).isDirectory()) addFiles(directory);
        } catch {
          /* Ignore disappearing directories and symlink escapes. */
        }
      }
    }
    return files;
  }
  private index() {
    const files = this.files(),
      rows: NativeSession[] = [];
    for (const file of files) {
      try {
        const stats = fs.statSync(file);
        if (!stats.isFile() || stats.mtimeMs < Date.now() - RECENT_SESSION_MS) continue;
        const cached = this.headers.get(file);
        if (cached?.stamp === stamp(stats)) {
          rows.push(cached.row);
          continue;
        }
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (opened.dev !== stats.dev || opened.ino !== stats.ino) continue;
          const buffer = Buffer.alloc(8192);
          const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const header = JSON.parse(
            buffer.subarray(0, length).toString("utf8").split("\n")[0]!,
          );
          if (
            header.type !== "session" ||
            !Id.safeParse(header.id).success ||
            typeof header.cwd !== "string"
          )
            continue;
          if (fs.realpathSync(file) !== file || !mainHistory(this.config, file))
            continue;
          const row = {
            path: file,
            id: header.id,
            nativeId: header.id,
            cwd: header.cwd,
            modified: stats.mtime,
            ambiguous: false,
          };
          this.headers.set(file, { stamp: stamp(stats), row });
          rows.push(row);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* Invalid, incomplete or unavailable native headers stay local. */
      }
    }
    for (const file of this.headers.keys())
      if (!files.has(file)) {
        this.headers.delete(file);
        this.names.delete(file);
      }
    const counts = new Map<string, number>();
    for (const row of rows)
      counts.set(row.nativeId, (counts.get(row.nativeId) ?? 0) + 1);
    return rows
      .map((row) =>
        counts.get(row.nativeId)! > 1
          ? { ...row, id: reference(row.path), ambiguous: true }
          : row,
      )
      .sort((a, b) => +b.modified - +a.modified);
  }
  private named(row: NativeSession) {
    const stats = fs.statSync(row.path),
      cached = this.names.get(row.path);
    if (cached?.stamp === stamp(stats)) return { ...row, name: cached.name };
    const fd = fs.openSync(row.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let name: string | undefined;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stats.dev || opened.ino !== stats.ino)
        throw new RemoteError("session_changed", 409);
      // Never scan multi-GB transcripts for a label. Metadata outside these
      // windows uses a neutral label until its native owner publishes its name.
      const starts =
        stats.size <= NAME_WINDOW_BYTES
          ? [0]
          : [0, Math.max(0, stats.size - NAME_WINDOW_BYTES)];
      for (const start of starts) {
        const buffer = Buffer.alloc(Math.min(NAME_WINDOW_BYTES, stats.size - start));
        const length = fs.readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, length).toString("utf8").split("\n");
        if (start) lines.shift();
        for (const line of lines) {
          if (
            line.length > 16384 ||
            !/^\s*\{\s*"type"\s*:\s*"session_info"\s*[,}]/.test(line)
          )
            continue;
          try {
            const entry = JSON.parse(line);
            if (typeof entry.name === "string") name = entry.name.slice(0, 1000);
          } catch {
            /* Ignore a partial append. */
          }
        }
      }
      if (fs.realpathSync(row.path) !== row.path || !mainHistory(this.config, row.path))
        throw new RemoteError("session_changed", 409);
      if (stamp(fs.statSync(row.path)) === stamp(stats))
        this.names.set(row.path, { stamp: stamp(stats), name });
      return { ...row, name };
    } finally {
      fs.closeSync(fd);
    }
  }
  async folders(excluded: string[] = []): Promise<SessionFolder[]> {
    const omit = new Set(excluded),
      groups = new Map<string, SessionFolder>();
    for (const row of this.index()) {
      if (omit.has(row.path)) continue;
      const group = groups.get(row.cwd) ?? { cwd: row.cwd, count: 0, lastActivity: 0 };
      group.count++;
      group.lastActivity = Math.max(group.lastActivity, +row.modified);
      groups.set(row.cwd, group);
    }
    return [...groups.values()];
  }
  async catalog(cwd?: string) {
    return this.index()
      .filter((row) => cwd === undefined || row.cwd === cwd)
      .flatMap((row) => {
        try {
          return [this.named(row)];
        } catch {
          return [];
        }
      });
  }
  async byId(id: string) {
    const row = this.index().find((session) => session.id === id);
    return row ? this.named(row) : undefined;
  }
  private async readEntries(
    file: string,
  ): Promise<{ entries: NativeEntry[]; truncated: boolean }> {
    const api = await this.module;
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { entries: [], truncated: false };
      throw error;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= HISTORY_BYTES)
        return {
          entries: api.parseSessionEntries(fs.readFileSync(fd, "utf8")),
          truncated: false,
        };
      const header = Buffer.alloc(8192);
      const headLength = fs.readSync(fd, header, 0, header.length, 0);
      const first = header.subarray(0, headLength).toString("utf8").split("\n")[0]!;
      const tail = Buffer.alloc(RECENT_HISTORY_BYTES);
      const length = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      const text = tail.subarray(0, length).toString("utf8");
      const newline = text.indexOf("\n");
      return {
        entries: api.parseSessionEntries(
          first + "\n" + (newline < 0 ? "" : text.slice(newline + 1)),
        ),
        truncated: true,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  async entries(file: string) {
    return (await this.readEntries(file)).entries;
  }
  async messages(file: string, offset = 0, limit = 100, expectedId?: string) {
    const api = await this.module;
    const { entries: all, truncated } = await this.readEntries(file);
    if (
      expectedId &&
      all.length &&
      all.find((entry) => entry.type === "session")?.id !== expectedId
    )
      throw new RemoteError("session_changed", 409);
    const projection = api.buildSessionProjection(
      all.filter((entry) => entry.type !== "session"),
    );
    return {
      messages: projection.messages.slice(offset, offset + limit),
      ...(truncated ? { truncated: true } : {}),
      offset,
      next: offset + limit < projection.messages.length ? offset + limit : null,
      total: projection.messages.length,
    };
  }
}
