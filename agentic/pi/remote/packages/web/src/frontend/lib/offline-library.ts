import type { Message } from "../stores/sessions.ts";
export interface OfflineSummary {
  sessionId: string;
  name?: string;
  cwd: string;
  lastActivity: number;
}
export interface OfflineCopy extends OfflineSummary {
  messages: Message[];
  synced: number;
  limited: boolean;
}
interface LibraryState {
  epoch: number;
  copies: OfflineCopy[];
}
const MAX_COPY = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const placeholder = "[Image unavailable offline]";
function text(value: string) {
  return value
    .replace(/data:image\/[^\s"'<>)]*/gi, placeholder)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, placeholder)
    .replace(/<img\b[^>]*>/gi, placeholder);
}
function argument(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[Nested content omitted]";
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((v) => argument(v, depth + 1));
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (row.type === "image" || row.type === "image_url") return placeholder;
    return Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !/^(data|base64|image|images|image_url)$/i.test(key))
        .map(([key, v]) => [key, argument(v, depth + 1)]),
    );
  }
  return value;
}
/** Text projection is the only route from live transcripts into persistent storage. */
export function offlineMessages(messages: Message[]): Message[] {
  return messages.map((m) => ({
    role: m.role,
    timestamp: m.timestamp,
    remoteHistoryKey: m.remoteHistoryKey,
    customType: m.customType,
    display: m.display,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    isError: m.isError,
    toolDisplay: typeof m.toolDisplay === "string" ? text(m.toolDisplay) : undefined,
    content:
      typeof m.content === "string"
        ? text(m.content)
        : m.content?.map((p) =>
            p.type === "image"
              ? { type: "text", text: placeholder }
              : {
                  type: p.type,
                  id: p.id,
                  name: p.name,
                  text: p.text === undefined ? undefined : text(p.text),
                  thinking: p.thinking === undefined ? undefined : text(p.thinking),
                  arguments: argument(p.arguments),
                  toolDisplay:
                    p.toolDisplay === undefined ? undefined : text(p.toolDisplay),
                },
          ),
  }));
}
/** Atomic epochs prevent responses started before clear/purge from restoring copies. */
export class OfflineLibrary {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = "pi-remote-offline-v1") {}
  private open() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  private async state(change?: (state: LibraryState) => void) {
    const database = await this.open();
    return new Promise<LibraryState>((resolve, reject) => {
      const tx = database.transaction("library", change ? "readwrite" : "readonly");
      const store = tx.objectStore("library");
      const request = store.get("state");
      let result: LibraryState;
      request.onsuccess = () => {
        result = request.result ?? { epoch: 0, copies: [] };
        if (change) {
          change(result);
          store.put(result, "state");
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  read() {
    return this.state();
  }
  async save(
    summary: OfflineSummary,
    messages: Message[],
    epoch: number,
    limited = false,
  ) {
    const copy: OfflineCopy = {
      sessionId: summary.sessionId,
      name: summary.name,
      cwd: summary.cwd,
      lastActivity: summary.lastActivity,
      messages: offlineMessages(messages),
      synced: Date.now(),
      limited,
    };
    while (copy.messages.length && bytes(copy) > MAX_COPY) {
      copy.messages.shift();
      copy.limited = true;
    }
    return this.state((state) => {
      if (state.epoch !== epoch) return;
      state.copies = [
        copy,
        ...state.copies.filter((r) => r.sessionId !== copy.sessionId),
      ]
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, 20);
      while (state.copies.length && bytes(state.copies) > MAX_TOTAL) state.copies.pop();
    });
  }
  remove(ids: string[]) {
    return this.state((state) => {
      state.epoch++;
      state.copies = state.copies.filter((row) => !ids.includes(row.sessionId));
    });
  }
  clear() {
    return this.state((state) => {
      state.epoch++;
      state.copies = [];
    });
  }
}
