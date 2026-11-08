import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { Config } from "./config.ts";
interface NativeSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: Date;
  firstMessage: string;
  messageCount: number;
}
interface NativeEntry {
  type: string;
  id?: string;
  parentId?: string;
  [key: string]: unknown;
}
interface NativeModule {
  SessionManager: { listAll: () => Promise<NativeSession[]> };
  parseSessionEntries: (s: string) => NativeEntry[];
  buildSessionProjection: (
    entries: NativeEntry[],
    leaf?: string | null,
  ) => { messages: unknown[] };
}
export class History {
  module: Promise<NativeModule>;
  constructor(readonly config: Config) {
    this.module = import(
      pathToFileURL(
        path.join(
          process.env.PI_CLI_PACKAGE ||
            path.join(
              execFileSync(
                path.join(path.dirname(process.execPath), "npm"),
                ["root", "-g"],
                { encoding: "utf8" },
              ).trim(),
              "@earendil-works/pi-coding-agent",
            ),
          "dist/core/session-manager.js",
        ),
      ).href
    );
  }
  async catalog() {
    const api = await this.module;
    if (!fs.existsSync(path.join(this.config.agentDir, "sessions"))) return [];
    const root = fs.realpathSync(path.join(this.config.agentDir, "sessions"));
    return (await api.SessionManager.listAll()).filter((s) => {
      const rel = path.relative(root, fs.realpathSync(s.path));
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });
  }
  async byId(id: string) {
    return (await this.catalog()).find((s) => s.id === id);
  }
  async entries(file: string) {
    const api = await this.module;
    const content = fs.readFileSync(file, "utf8");
    return api.parseSessionEntries(content);
  }
  async messages(file: string, offset = 0, limit = 100) {
    const api = await this.module;
    const entries = (await this.entries(file)).filter((e) => e.type !== "session");
    const projection = api.buildSessionProjection(entries);
    return {
      messages: projection.messages.slice(offset, offset + limit),
      offset,
      next: offset + limit < projection.messages.length ? offset + limit : null,
      total: projection.messages.length,
    };
  }
}
