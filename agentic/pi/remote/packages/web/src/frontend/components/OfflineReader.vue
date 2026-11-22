<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useOffline } from "../stores/offline.ts";
import Transcript from "./Transcript.vue";
const route = useRoute();
const offline = useOffline();
const tools = ref(false),
  thinking = ref(false);
const copy = computed(() =>
  offline.copies.find((row) => row.sessionId === route.params.id),
);
const isConversation = computed(() => route.path.startsWith("/session/"));
const list = computed(() =>
  [...offline.copies].sort((a, b) => b.lastActivity - a.lastActivity),
);
function anchor() {
  if (!isConversation.value) return;
  const rows = document.querySelectorAll<HTMLElement>("[data-history-row]");
  const row = [...rows].find((r) => r.getBoundingClientRect().bottom > 130);
  offline.resumeAnchor = {
    sessionId: String(route.params.id),
    key: row?.dataset.historyRow,
    offset: row?.getBoundingClientRect().top ?? 0,
    top: window.scrollY,
  };
}
onBeforeUnmount(anchor);
watch(() => offline.revision, anchor);
onMounted(async () => {
  await nextTick();
  if (isConversation.value) window.scrollTo(0, document.documentElement.scrollHeight);
});
watch(
  () => route.params.id,
  async () => {
    await nextTick();
    if (isConversation.value) window.scrollTo(0, document.documentElement.scrollHeight);
  },
);
</script>
<template>
  <section class="offline-reader">
    <p
      role="status"
      class="card"
    >
      Offline copy. Read-only while your Mac is unreachable.
      <template v-if="copy"
        >Last synced {{ new Date(copy.synced).toLocaleString() }}.</template
      >
      <button @click="offline.requestRefresh()">Try reconnecting</button>
    </p>
    <p
      v-if="offline.error"
      role="alert"
    >
      {{ offline.error }}
    </p>
    <template v-if="route.path === '/settings'">
      <h1>Settings</h1>
      <p>{{ offline.copies.length }} conversations saved on this phone.</p>
      <button @click="offline.clear()">Clear all offline conversations</button>
    </template>
    <template v-else-if="isConversation">
      <template v-if="copy">
        <h1>{{ copy.name || "Saved conversation" }}</h1>
        <div class="row">
          <button
            :aria-pressed="tools"
            @click="tools = !tools"
          >
            Tool outputs
          </button>
          <button
            :aria-pressed="thinking"
            @click="thinking = !thinking"
          >
            Reasoning
          </button>
        </div>
        <p class="muted small">
          Saved messages only. Earlier messages and images may be unavailable offline.
        </p>
        <Transcript
          :messages="copy.messages"
          :tools-expanded="tools"
          :thinking-expanded="thinking"
          offline
        />
      </template>
      <p
        v-else
        role="status"
      >
        This conversation is not saved on this phone. Reconnect to your Mac to open it.
      </p>
      <div class="offline-composer">
        <textarea
          disabled
          aria-label="Message"
          placeholder="Offline copies are read-only"
        />
        <button disabled>Send</button>
      </div>
    </template>
    <template v-else>
      <h1>Saved conversations</h1>
      <button disabled>New conversation</button>
      <p v-if="!list.length">
        No conversations saved on this phone. Connect to your Mac to save recent
        conversations.
      </p>
      <ul>
        <li
          v-for="row in list"
          :key="row.sessionId"
          class="card"
        >
          <RouterLink :to="`/session/${row.sessionId}`">{{
            row.name || "Saved conversation"
          }}</RouterLink>
          <p class="small muted">{{ row.cwd }}</p>
        </li>
      </ul>
    </template>
  </section>
</template>
<style scoped>
ul {
  list-style: none;
  padding: 0;
}
li {
  margin: 10px 0;
}
.offline-composer {
  position: sticky;
  bottom: 0;
  background: var(--panel);
  padding: 12px;
  display: flex;
  gap: 8px;
}
.offline-composer textarea {
  flex: 1;
}
</style>
