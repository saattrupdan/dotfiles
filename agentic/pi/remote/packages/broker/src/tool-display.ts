import { boundedToolArguments } from "../../../../extensions/_tool-display/arguments.ts";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolvePiPackage } from "../../../../profile/pi-runtime.mjs";
import type { StreamEvent } from "../../protocol/src/index.ts";

import type { ToolBlock } from "../../../../extensions/_tool-display/block.ts";

type RecordValue = Record<string, unknown>;
type Present = (
  name: string,
  args: unknown,
  result: unknown,
  id: string,
  cwd: string,
) => ToolBlock;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Adds native display text to transport copies, never to native history or stored events. */
export class ToolDisplay {
  private load?: Promise<Present | undefined>;
  private calls = new Map<string, { name: string; args: unknown; bytes: number }>();
  private callBytes = 0;
  private rendered = new Map<string, ToolBlock>();
  private queues = new Map<string, Promise<void>>();
  constructor(private agentDir: string) {}
  private renderer() {
    return (this.load ??= (async () => {
      const file = path.join(this.agentDir, "extensions/_tool-display/presentation.ts");
      if (!fs.existsSync(file)) return;
      const sdk = resolvePiPackage();
      const require = createRequire(path.join(sdk, "package.json"));
      const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
      const jiti = createJiti(file, {
        moduleCache: true,
        fsCache: false,
        alias: {
          "@earendil-works/pi-coding-agent": path.join(sdk, "dist/index.js"),
          "@earendil-works/pi-tui": path.join(
            sdk,
            "node_modules/@earendil-works/pi-tui/dist/index.js",
          ),
        },
      });
      const module = await jiti.import(file);
      return module.toolPresentationBlock as Present;
    })().catch(() => undefined));
  }
  private remember(key: string, name: string, args: unknown) {
    const bounded = boundedToolArguments(args);
    const bytes = Buffer.byteLength(JSON.stringify(bounded.args));
    const previous = this.calls.get(key);
    if (previous) this.callBytes -= previous.bytes;
    this.calls.delete(key);
    this.calls.set(key, { name, args: bounded.args, bytes });
    this.callBytes += bytes;
    while (this.calls.size > 512 || this.callBytes > 4 * 1024 * 1024) {
      const oldest = this.calls.keys().next().value!;
      this.callBytes -= this.calls.get(oldest)!.bytes;
      this.calls.delete(oldest);
    }
  }
  async messages(messages: unknown[], cwd: string, scope: string): Promise<unknown[]> {
    const present = await this.renderer();
    const batch = new Map<string, { name: string; args: unknown }>();
    for (const message of messages) {
      if (
        !record(message) ||
        message.role !== "assistant" ||
        !Array.isArray(message.content)
      )
        continue;
      for (const part of message.content) {
        if (
          record(part) &&
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          batch.set(`${scope}:${part.id}`, {
            name: part.name,
            args: part.arguments,
          });
          this.remember(`${scope}:${part.id}`, part.name, part.arguments);
        }
      }
    }
    const text = (name: string, args: unknown, result: unknown, id: string) => {
      if (!present)
        return {
          text: `${name}\nTool display unavailable. Expand for full output.`,
          styles: [],
        };
      const key = createHash("sha256")
        .update(JSON.stringify([name, args, result, id, cwd]))
        .digest("hex");
      const cached = this.rendered.get(key);
      if (cached !== undefined) return cached;
      let output: ToolBlock;
      try {
        output = present(name, args, result, id, cwd);
      } catch {
        output = {
          text: `${name}\nTool display unavailable. Expand for full output.`,
          styles: [],
        };
      }
      this.rendered.set(key, output);
      if (this.rendered.size > 256)
        this.rendered.delete(this.rendered.keys().next().value!);
      return output;
    };
    return messages.map((message) => {
      if (!record(message)) return message;
      if (message.role === "toolResult") {
        const id = String(message.toolCallId ?? "");
        const call = batch.get(`${scope}:${id}`) ?? this.calls.get(`${scope}:${id}`);
        const name =
          typeof message.toolName === "string"
            ? message.toolName
            : (call?.name ?? "tool");
        const block = text(name, call?.args, message, id);
        return {
          ...message,
          toolDisplay: block.text,
          toolDisplayStyles: [...block.styles],
        };
      }
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (
            !record(part) ||
            part.type !== "toolCall" ||
            typeof part.name !== "string"
          )
            return part;
          const block = text(
            part.name,
            part.arguments,
            undefined,
            String(part.id ?? ""),
          );
          return {
            ...part,
            toolDisplay: block.text,
            toolDisplayStyles: [...block.styles],
          };
        }),
      };
    });
  }
  /** Serializes formatting so a slow first import cannot reorder streamed messages or receipts. */
  emit(
    event: StreamEvent,
    cwd: string,
    publish: (event: StreamEvent) => void,
    scope = event.sessionId ?? "",
  ) {
    const key = event.sessionId ?? "";
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let data = event.data;
        if (event.type === "snapshot" && Array.isArray(data))
          data = await this.messages(data, cwd, scope);
        if (["message_update", "message_end"].includes(event.type))
          data = (await this.messages([data], cwd, scope))[0];
        publish(data === event.data ? event : { ...event, data });
      });
    this.queues.set(key, pending);
    void pending
      .catch(() => {
        try {
          publish({ ...event, type: "resnapshot", data: null });
        } catch {
          /* Disconnected transport. */
        }
      })
      .finally(() => {
        if (this.queues.get(key) === pending) this.queues.delete(key);
      });
  }
}
