import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { RemoteError } from "../../protocol/src/index.ts";

export interface HistoryWindow {
  before?: string;
  anchor?: string;
  proof?: string;
  count?: number;
}
type Message = Record<string, unknown>;
interface Projection {
  messages: Message[];
  truncated: boolean;
}
interface Snapshot extends Projection {
  id: string;
  file: string;
  nativeId: string;
  stamp: string;
  bytes: number;
  expires: number;
}
const BUDGET = 128 * 1024 * 1024;
const TTL = 5 * 60 * 1000;

/** Cursors pin immutable native projections; appends cannot move page boundaries. */
export class HistoryPages {
  private snapshots = new Map<string, Snapshot>();
  private pending = new Map<string, Promise<Snapshot>>();
  constructor(
    private readonly project: (file: string, nativeId: string) => Promise<Projection>,
  ) {}

  private async latest(file: string, nativeId: string) {
    let stamp = "missing";
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = `${file}\0${nativeId}\0${stamp}`;
    const cached = [...this.snapshots.values()].find(
      (row) => row.file === file && row.nativeId === nativeId && row.stamp === stamp,
    );
    if (cached) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    const task = (async () => {
      const result = await this.project(file, nativeId);
      const bytes = Buffer.byteLength(JSON.stringify(result.messages));
      if (bytes > BUDGET) throw new RemoteError("history_too_large", 413);
      while (
        this.snapshots.size >= 8 ||
        [...this.snapshots.values()].reduce((sum, row) => sum + row.bytes, 0) + bytes >
          BUDGET
      )
        this.snapshots.delete(this.snapshots.keys().next().value!);
      const row: Snapshot = {
        ...result,
        id: randomUUID(),
        file,
        nativeId,
        stamp,
        bytes,
        expires: Date.now() + TTL,
      };
      this.snapshots.set(row.id, row);
      return row;
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  async read(file: string, nativeId: string, options: HistoryWindow = {}) {
    const cursor = options.before;
    const anchor = options.anchor;
    for (const [key, row] of this.snapshots)
      if (row.expires <= Date.now()) this.snapshots.delete(key);
    const parts = cursor?.match(/^([0-9a-f-]{36}):(\d{1,9})$/);
    const row = cursor
      ? parts && this.snapshots.get(parts[1]!)
      : await this.latest(file, nativeId);
    if (!row || row.file !== file || row.nativeId !== nativeId)
      throw new RemoteError("history_cursor_expired", 409);
    const end = cursor ? Number(parts![2]) : row.messages.length;
    if (end > row.messages.length || end < 0)
      throw new RemoteError("history_cursor_expired", 409);
    let start = end,
      turns = 0,
      bytes = 0;
    while (start > 0 && end - start < 200) {
      const message = row.messages[start - 1]!;
      const size = Buffer.byteLength(JSON.stringify(message));
      if (start < end && bytes + size > 512 * 1024) break;
      start--;
      bytes += size;
      if (message.role === "user" && ++turns === 5) break;
    }
    const position = anchor
      ? row.messages.findIndex((message) => message.remoteHistoryKey === anchor)
      : -1;
    const compatible =
      position >= 0 &&
      !!options.proof &&
      !!options.count &&
      createHash("sha256")
        .update(
          row.messages
            .slice(position, position + options.count)
            .map((message) => message.remoteHistoryKey)
            .join("\n"),
        )
        .digest("hex") === options.proof;
    return {
      anchorFound: compatible,
      anchoredOlder: compatible && position > 0 ? `${row.id}:${position}` : null,
      messages: row.messages.slice(start, end),
      revision: row.id,
      older: start > 0 ? `${row.id}:${start}` : null,
      truncated: row.truncated,
      total: row.messages.length,
    };
  }
}

export function historyKey(sourceId: string, ordinal: number, message: unknown) {
  return createHash("sha256")
    .update(`${sourceId}:${ordinal}\0${JSON.stringify(message)}`)
    .digest("hex");
}
