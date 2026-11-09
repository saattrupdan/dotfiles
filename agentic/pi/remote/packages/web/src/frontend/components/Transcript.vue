<!-- v-html receives only DOMPurify-sanitized Markdown. -->
<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Message } from "../stores/sessions.ts";
defineProps<{ messages: Message[]; streaming?: Message }>();
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
    "^\\[Image: original \\d+x\\d+, displayed at \\d+x\\d+\\. " +
      "Multiply coordinates by \\d+(?:\\.\\d+)? to map to original image\\.\\]$",
  );
  return content.filter(
    (part, index) =>
      part.type !== "text" ||
      !sizing.test(part.text?.trim() ?? "") ||
      ![content[index - 1], content[index + 1]].some(
        (neighbor) => neighbor?.type === "image",
      ),
  );
};
</script>
<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    class="transcript"
    aria-live="polite"
  >
    <article
      v-for="(message, index) in [...messages, ...(streaming ? [streaming] : [])]"
      :key="index"
      :class="['message', message.role]"
    >
      <template v-if="message.role === 'toolResult'">
        <details class="tool">
          <summary>
            {{ message.isError ? "Failed" : "Result" }}:
            {{ message.toolName || "tool" }}
          </summary>
          <div
            v-for="(part, p) in parts(message)"
            :key="p"
          >
            <div
              v-if="part.text"
              v-html="clean(part.text)"
            />
          </div>
        </details>
      </template>
      <template v-else>
        <div class="role">
          {{
            message.role === "user"
              ? "You"
              : message.role === "assistant"
                ? "Pi"
                : message.customType || "Notice"
          }}
        </div>
        <template
          v-for="(part, p) in parts(message)"
          :key="p"
        >
          <details
            v-if="part.type === 'thinking'"
            class="thinking"
          >
            <summary>Thinking</summary>
            <p>{{ part.thinking }}</p>
          </details>
          <details
            v-else-if="part.type === 'toolCall'"
            class="tool"
          >
            <summary>{{ part.name }}</summary>
            <pre>{{ JSON.stringify(part.arguments, null, 2) }}</pre>
          </details>
          <img
            v-else-if="
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
      </template>
    </article>
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
.tool {
  font-size: 12px;
  background: #0c161c;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  margin: 8px 0;
}
.thinking {
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
