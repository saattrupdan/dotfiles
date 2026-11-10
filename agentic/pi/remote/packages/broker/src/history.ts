import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
import { Id, RemoteError, type SessionFolder } from "../../protocol/src/index.ts";
import {
  mainHistory,
  sessionRoots,
  visibleWorkingDirectory,
} from "./deployment-scope.ts";
import type { Config } from "./config.ts";

export const RECENT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
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
  private names = new Map<
    string,
    { stamp: string; identity: string; size: number; offset: number; name?: string }
  >();
  private naming = new Map<string, Promise<NativeSession>>();
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
          if (!visibleWorkingDirectory(this.config, cached.row.cwd)) continue;
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
            typeof header.cwd !== "string" ||
            !visibleWorkingDirectory(this.config, header.cwd)
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
  private async named(row: NativeSession): Promise<NativeSession> {
    const pending = this.naming.get(row.path);
    if (pending) return pending;
    const task = this.readName(row);
    this.naming.set(row.path, task);
    try {
      return await task;
    } finally {
      this.naming.delete(row.path);
    }
  }
  private async readName(row: NativeSession): Promise<NativeSession> {
    const fd = fs.openSync(row.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stats = fs.fstatSync(fd),
        identity = `${stats.dev}:${stats.ino}:${row.nativeId}`;
      const cached = this.names.get(row.path);
      if (cached?.stamp === stamp(stats)) return { ...row, name: cached.name };
      const append = cached?.identity === identity && stats.size > cached.size;
      const start = append ? cached.offset : 0;
      let offset = start,
        absolute = start,
        name = append ? cached.name : undefined;
      let partial = Buffer.alloc(0),
        discarded = false;
      // Scan labels only when their folder is opened, then only appended bytes.
      // Message/image records are discarded without JSON parsing or retention.
      if (stats.size > start)
        for await (const chunk of fs.createReadStream(row.path, {
          fd,
          autoClose: false,
          start,
          end: stats.size - 1,
          highWaterMark: 1024 * 1024,
        })) {
          const bytes = chunk as Buffer;
          let position = 0;
          while (position < bytes.length) {
            const newline = bytes.indexOf(10, position);
            const end = newline < 0 ? bytes.length : newline;
            const piece = bytes.subarray(position, end);
            if (!discarded && partial.length + piece.length <= 16384)
              partial = Buffer.concat([partial, piece]);
            else {
              discarded = true;
              partial = Buffer.alloc(0);
            }
            if (newline < 0) break;
            if (!discarded && partial.includes('"session_info"')) {
              try {
                const entry = JSON.parse(partial.toString("utf8"));
                if (entry.type === "session_info" && typeof entry.name === "string")
                  name = entry.name.trim().slice(0, 1000) || undefined;
              } catch {
                /* An incomplete append is read again on the next request. */
              }
            }
            partial = Buffer.alloc(0);
            discarded = false;
            offset = absolute + newline + 1;
            position = newline + 1;
          }
          absolute += bytes.length;
        }
      if (fs.realpathSync(row.path) !== row.path || !mainHistory(this.config, row.path))
        throw new RemoteError("session_changed", 409);
      this.names.set(row.path, {
        stamp: stamp(stats),
        identity,
        size: stats.size,
        offset,
        name,
      });
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
    const rows = this.index().filter((row) => cwd === undefined || row.cwd === cwd);
    const result: NativeSession[] = [];
    for (let i = 0; i < rows.length; i += 4) {
      const batch = await Promise.all(
        rows.slice(i, i + 4).map((row) => this.named(row).catch(() => undefined)),
      );
      result.push(...batch.filter((row): row is NativeSession => !!row));
    }
    return result;
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
