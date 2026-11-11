<!-- v-html receives only DOMPurify-sanitized Markdown. -->
<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { messageReceipt, receiptLabel } from "../lib/receipts.ts";
import type { ToolLineStyle } from "../../../../../../extensions/_tool-display/block-types.ts";
import type { Message } from "../stores/sessions.ts";
const props = defineProps<{
  messages: Message[];
  streaming?: Message;
  toolsExpanded?: boolean;
  thinkingExpanded?: boolean;
  statuses?: Record<string, string>;
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
type Tool = {
  kind: "tool";
  name: string;
  result?: Message;
  args?: unknown;
  display?: string;
  styles?: ToolLineStyle[];
};
type Row = (
  Tool | { kind: "message"; message: Message } | { kind: "thinking"; text: string }
) & { key: string };
const identities = new WeakMap<Message, number>();
let identity = 0;
function key(message: Message) {
  if (typeof message.remoteHistoryKey === "string") return message.remoteHistoryKey;
  if (!identities.has(message)) identities.set(message, ++identity);
  return `live:${identities.get(message)}`;
}
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
    const base = key(message);
    if (
      message.role === "system" ||
      (message.role === "custom" && message.display !== true)
    )
      return [];
    if (message.role === "toolResult")
      return [
        {
          kind: "tool",
          key: message.toolCallId ? `tool:${message.toolCallId}` : base,
          name: message.toolName || calls.get(message.toolCallId || "")?.name || "tool",
          result: message,
          display: message.toolDisplay,
          styles: message.toolDisplayStyles,
          args: calls.get(message.toolCallId || "")?.arguments,
        },
      ];
    const normal = parts(message).filter(
      (p) => !["thinking", "toolCall"].includes(p.type),
    );
    const rows: Row[] = [];
    if (normal.length)
      rows.push({
        key: `${base}:message`,
        kind: "message",
        message: { ...message, content: normal },
      });
    for (const [index, part] of parts(message).entries()) {
      if (part.type === "thinking")
        rows.push({
          key: `${base}:thinking:${index}`,
          kind: "thinking",
          text: part.thinking || "",
        });
      if (part.type === "toolCall" && (!part.id || !results.has(part.id)))
        rows.push({
          kind: "tool",
          key: part.id ? `tool:${part.id}` : `${base}:tool:${index}`,
          name: part.name || "tool",
          args: part.arguments,
          display: part.toolDisplay,
          styles: part.toolDisplayStyles,
        });
    }
    return rows;
  });
});
function callText(row: Tool) {
  return row.display?.split("\n")[0] || row.name;
}
function preview(row: Tool) {
  const lines = row.display?.split("\n").slice(1) ?? [
    "Tool display unavailable. Expand for full output.",
  ];
  return lines.map((text, index) => ({
    text,
    style: row.styles?.[index + 1] ?? "plain",
  }));
}
</script>
<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    class="transcript"
    aria-live="polite"
  >
    <template
      v-for="row in rows"
      :key="row.key"
    >
      <article
        v-if="row.kind === 'tool'"
        class="tool-entry"
        :class="{
          shell: ['bash', 'powershell'].includes(row.name),
          edit: row.name === 'edit',
        }"
        :data-history-row="row.key"
      >
        <div class="tool-name">{{ callText(row) }}</div>
        <div
          v-if="preview(row).length"
          class="tool-preview"
          :class="{ error: row.result?.isError }"
        >
          <span
            v-for="(line, index) in preview(row)"
            :key="index"
            :class="['tool-line', line.style]"
            >{{ line.text || "​" }}</span
          >
        </div>
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
        :data-history-row="row.key"
      >
        {{ row.text }}
      </div>
      <article
        v-else-if="row.kind === 'message'"
        :class="['message', row.message.role]"
        :data-history-row="row.key"
      >
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
        <span
          v-if="messageReceipt(row.message, statuses ?? {})"
          class="receipt"
          role="status"
          :aria-label="receiptLabel(messageReceipt(row.message, statuses ?? {})!)"
          :title="receiptLabel(messageReceipt(row.message, statuses ?? {})!)"
        >
          <span
            v-if="
              ['rejected', 'delivery_unknown'].includes(
                messageReceipt(row.message, statuses ?? {})!,
              )
            "
            >!</span
          >
          <Icon
            v-else
            :name="
              messageReceipt(row.message, statuses ?? {}) === 'received'
                ? 'check'
                : 'spinner'
            "
          />
        </span>
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
  background: var(--panel);
  padding: 10px 13px;
  border-radius: 3px 14px 14px 14px;
  margin: 8px auto 8px 0;
  width: fit-content;
  max-width: 94%;
  min-width: 40px;
  font-size: 15px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.message.user {
  background: var(--outgoing);
  border-radius: 14px 14px 3px 14px;
  margin-left: auto;
  margin-right: 0;
  max-width: 88%;
}
.message:not(.user):not(.assistant) {
  background: transparent;
  margin: 12px auto;
  color: var(--muted);
  font-size: 13px;
}
.receipt {
  display: flex;
  justify-content: end;
  color: #a6c9c2;
  margin: 3px 0 -2px;
}
.receipt :deep(svg) {
  width: 16px;
  height: 16px;
}
.tool-entry {
  font-size: 12px;
  background: none;
  border-left: 2px solid var(--line);
  padding: 4px 14px;
  margin: 8px 0;
}
.tool-name {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
.tool-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 5px 0;
  font-size: 13px;
  color: var(--muted);
}
.tool-line {
  display: block;
}
.tool-line.command {
  color: #e9edef;
  font-family: ui-monospace, monospace;
}
.shell .tool-preview,
.edit .tool-preview {
  font-family: ui-monospace, monospace;
}
.shell .tool-preview {
  margin-top: 0;
}
.tool-line.added {
  color: #8fdbab;
  background: #25d36612;
}
.tool-line.removed {
  color: #ffb5a8;
  background: #ff6b6b12;
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
