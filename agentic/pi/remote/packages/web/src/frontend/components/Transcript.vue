<!-- v-html receives only DOMPurify-sanitized Markdown. -->
<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Message } from "../stores/sessions.ts";
const props = defineProps<{
  messages: Message[];
  streaming?: Message;
  toolsExpanded?: boolean;
  thinkingExpanded?: boolean;
}>();
const clean = (s: string) =>
  DOMPurify.sanitize(
    marked.parse(s.replace(/<!-- pi-remote-command:[0-9a-f-]{36} -->\n?/g, ""), {
      async: false,
    }),
    {
      FORBID_TAGS: ["script", "style", "iframe", "form", "input", "button"],
      FORBID_ATTR: ["style"],
    },
  );
const parts = (m: Message) => {
  const content =
    typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : (m.content ?? []);
  const sizing = new RegExp(
    "(^|\\r?\\n)\\[Image: original \\d+x\\d+, displayed at \\d+x\\d+\\. " +
      "Multiply coordinates by \\d+(?:\\.\\d+)? to map to original image\\.\\]$",
  );
  return content.flatMap((part, index) => {
    if (
      part.type !== "text" ||
      ![content[index - 1], content[index + 1]].some(
        (neighbor) => neighbor?.type === "image",
      )
    )
      return [part];
    let text = part.text ?? "";
    while (sizing.test(text)) text = text.replace(sizing, "");
    if (text === part.text) return [part];
    return text.trim() ? [{ ...part, text }] : [];
  });
};
type Tool = { kind: "tool"; name: string; result?: Message; args?: unknown };
type Row =
  Tool | { kind: "message"; message: Message } | { kind: "thinking"; text: string };
const rows = computed<Row[]>(() => {
  const all = [...props.messages, ...(props.streaming ? [props.streaming] : [])];
  const results = new Set(
    all.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
  );
  const calls = new Map<string, { name?: string; arguments?: unknown }>();
  for (const message of all)
    for (const part of parts(message))
      if (part.type === "toolCall" && part.id) calls.set(part.id, part);
  return all.flatMap((message): Row[] => {
    if (message.role === "toolResult")
      return [
        {
          kind: "tool",
          name: message.toolName || calls.get(message.toolCallId || "")?.name || "tool",
          result: message,
          args: calls.get(message.toolCallId || "")?.arguments,
        },
      ];
    const normal = parts(message).filter(
      (p) => !["thinking", "toolCall"].includes(p.type),
    );
    const rows: Row[] = [];
    if (normal.length)
      rows.push({ kind: "message", message: { ...message, content: normal } });
    for (const part of parts(message)) {
      if (part.type === "thinking")
        rows.push({ kind: "thinking", text: part.thinking || "" });
      if (part.type === "toolCall" && (!part.id || !results.has(part.id)))
        rows.push({ kind: "tool", name: part.name || "tool", args: part.arguments });
    }
    return rows;
  });
});
function preview(row: Tool) {
  if (!row.result) return "Running...";
  const text = parts(row.result)
    .map((part) => part.text || "")
    .join("\n");
  if (row.name === "store_memory" && !row.result.isError && /queued/i.test(text))
    return "Queued a memory";
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^\[toolCallId:/.test(line))
      ?.slice(0, 180) || (row.result.isError ? "Failed" : "Completed")
  );
}
</script>
<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    class="transcript"
    aria-live="polite"
  >
    <template
      v-for="(row, index) in rows"
      :key="index"
    >
      <article
        v-if="row.kind === 'tool'"
        class="tool-entry"
      >
        <div class="tool-name">{{ row.name }}</div>
        <p
          class="tool-preview"
          :class="{ error: row.result?.isError }"
        >
          <Icon
            :name="!row.result ? 'spinner' : row.result.isError ? 'close' : 'check'"
          />
          <span>{{ preview(row) }}</span>
        </p>
        <div
          v-if="toolsExpanded"
          class="tool-output"
        >
          <pre v-if="row.args">{{ JSON.stringify(row.args, null, 2) }}</pre>
          <template v-if="row.result">
            <div
              v-for="(part, p) in parts(row.result)"
              :key="p"
            >
              <img
                v-if="
                  part.type === 'image' &&
                  ['image/png', 'image/jpeg', 'image/webp'].includes(
                    part.mimeType || '',
                  )
                "
                :src="`data:${part.mimeType};base64,${part.data}`"
                alt="Tool output image"
              />
              <div
                v-else-if="part.text"
                v-html="clean(part.text)"
              />
            </div>
          </template>
        </div>
      </article>
      <div
        v-else-if="row.kind === 'thinking'"
        v-show="thinkingExpanded"
        class="thinking"
      >
        {{ row.text }}
      </div>
      <article
        v-else-if="row.kind === 'message'"
        :class="['message', row.message.role]"
      >
        <div class="role">
          {{
            row.message.role === "user"
              ? "You"
              : row.message.role === "assistant"
                ? "Pi"
                : row.message.customType || "Notice"
          }}
        </div>
        <template
          v-for="(part, p) in parts(row.message)"
          :key="p"
        >
          <img
            v-if="
              part.type === 'image' &&
              ['image/png', 'image/jpeg', 'image/webp'].includes(part.mimeType || '')
            "
            :src="`data:${part.mimeType};base64,${part.data}`"
            alt="Conversation image"
          />
          <div
            v-else-if="part.text"
            class="markdown"
            v-html="clean(part.text)"
          />
        </template>
      </article>
    </template>
    <p
      v-if="!messages.length && !streaming"
      class="muted"
    >
      A fresh conversation. What are we working on?
    </p>
  </div>
</template>
<style scoped>
.message {
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
  font-size: 15px;
  line-height: 1.6;
}
.message.user {
  background: #1a3035;
  padding: 16px;
  border-radius: 16px;
  margin: 16px 0;
  border: 0;
}
.role {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 8px;
}
.tool-entry {
  font-size: 12px;
  background: none;
  border-left: 2px solid var(--line);
  padding: 4px 14px;
  margin: 8px 0;
}
.tool-name {
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
.tool-preview {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 5px 0;
  font-size: 13px;
  color: var(--muted);
}
.tool-preview :deep(svg) {
  width: 14px;
  height: 14px;
  align-self: center;
}
.tool-output {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.thinking {
  white-space: pre-wrap;
  margin: 12px 0;
  font-size: 12px;
  color: var(--muted);
}
.markdown :deep(p:first-child) {
  margin-top: 0;
}
.markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.transcript {
  padding-bottom: 20px;
}
</style>
