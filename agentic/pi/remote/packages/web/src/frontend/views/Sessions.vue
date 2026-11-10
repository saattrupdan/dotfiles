<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { isUsersDirectory } from "../lib/session-paths.ts";
import Icon from "../components/Icon.vue";
import { useSessions } from "../stores/sessions.ts";
const store = useSessions();
const folder = computed(() => store.folder);
const search = ref("");
const filter = ref("all");
const error = ref("");
const loading = ref(false);
let navigation = 0;
async function browse(cwd?: string) {
  const expected = ++navigation;
  if (cwd !== undefined && !isUsersDirectory(cwd)) {
    store.folder = undefined;
    return;
  }

  search.value = "";
  filter.value = "all";
  error.value = "";
  loading.value = true;
  try {
    if (cwd === undefined) await store.loadFolders();
    else await store.refresh(cwd);
  } catch (e) {
    if (expected === navigation) error.value = (e as Error).message;
  } finally {
    if (expected === navigation) loading.value = false;
  }
}
onMounted(() => {
  store.connect("");
});
watch(folder, browse, { immediate: true });
onUnmounted(() => {
  navigation++;
  store.disconnect(true);
});
const folders = computed(() =>
  store.folders.filter(
    (entry) =>
      isUsersDirectory(entry.cwd) &&
      entry.cwd.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const activeStates = new Set(["idle", "running", "waiting", "answer_needed"]);
const filtered = computed(() =>
  store.listing
    .filter(
      (session) =>
        (filter.value === "all" || session.state === filter.value) &&
        `${session.name} ${session.sessionId} ${session.cwd}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(activeStates.has(b.state)) - Number(activeStates.has(a.state)) ||
        b.lastActivity - a.lastActivity,
    ),
);
const active = computed(() =>
  filtered.value.filter(
    (session) => activeStates.has(session.state) && isUsersDirectory(session.cwd),
  ),
);
const basename = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) || cwd;
</script>
<template>
  <section>
    <div class="row heading">
      <h1>Conversations</h1>
      <RouterLink
        to="/new"
        class="new icon-button"
        aria-label="New conversation"
        title="New conversation"
        >+</RouterLink
      >
    </div>
    <div class="row context">
      <button
        v-if="folder !== undefined"
        class="icon-button"
        aria-label="Back to folders"
        title="Back to folders"
        @click="store.folder = undefined"
      >
        <Icon name="back" />
      </button>
      <span class="small muted">Last 7 days</span>
    </div>
    <p
      v-if="folder"
      class="path selected-folder"
    >
      {{ folder }}
    </p>
    <div class="filters">
      <input
        v-model="search"
        type="search"
        :aria-label="
          folder === undefined ? 'Search sessions and folders' : 'Search conversations'
        "
        placeholder="Search"
      />
      <select
        v-if="folder !== undefined"
        v-model="filter"
        aria-label="Filter state"
      >
        <option value="all">All</option>
        <option
          v-for="state in ['running', 'idle', 'waiting', 'stopped', 'interrupted']"
          :key="state"
          :value="state"
        >
          {{ state }}
        </option>
      </select>
    </div>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="loading"
      class="small muted"
      role="status"
    >
      Loading...
    </p>
    <div
      v-else-if="folder === undefined"
      class="home"
    >
      <section aria-labelledby="active-sessions-heading">
        <h2
          id="active-sessions-heading"
          class="section-title"
        >
          Active sessions
        </h2>
        <div class="list">
          <RouterLink
            v-for="session in active"
            :key="session.sessionId"
            :to="`/session/${session.sessionId}`"
            class="session"
          >
            <div class="row">
              <span :class="['dot', session.state]" />
              <span class="state">{{
                session.state === "answer_needed" ? "answer needed" : session.state
              }}</span>
            </div>
            <h3>{{ session.name || "Saved conversation" }}</h3>
            <p class="path">{{ session.cwd }}</p>
          </RouterLink>
          <p
            v-if="!active.length"
            class="empty muted"
          >
            {{ search ? "No matches" : "No active sessions" }}
          </p>
        </div>
      </section>
      <section aria-labelledby="folders-heading">
        <h2
          id="folders-heading"
          class="section-title"
        >
          Folders
        </h2>
        <div class="list">
          <button
            v-for="entry in folders"
            :key="entry.cwd"
            class="folder"
            @click="store.folder = entry.cwd"
          >
            <div class="row">
              <h3>{{ basename(entry.cwd) }}</h3>
              <span class="time">{{ entry.count }}</span>
            </div>
            <p class="path">{{ entry.cwd }}</p>
          </button>
          <p
            v-if="!folders.length"
            class="empty muted"
          >
            {{ search ? "No matches" : "No conversations in the last 7 days" }}
          </p>
        </div>
      </section>
    </div>
    <div
      v-else
      class="list"
    >
      <RouterLink
        v-for="session in filtered"
        :key="session.sessionId"
        :to="`/session/${session.sessionId}`"
        class="session"
      >
        <div class="row">
          <span :class="['dot', session.state]" /><span class="state">{{
            session.prompt?.state === "expired" ? "answer needed" : session.state
          }}</span
          ><span class="time">{{
            new Date(session.lastActivity).toLocaleDateString()
          }}</span>
        </div>
        <h2>{{ session.name || "Saved conversation" }}</h2>
      </RouterLink>
      <p
        v-if="!filtered.length"
        class="empty muted"
      >
        {{ search || filter !== "all" ? "No matches" : "No recent conversations" }}
      </p>
    </div>
  </section>
</template>
<style scoped>
.heading {
  justify-content: space-between;
  margin-bottom: 12px;
}
.heading h1 {
  margin: 0;
}
.context {
  justify-content: space-between;
  margin-bottom: 16px;
}
.selected-folder {
  margin-bottom: 14px;
}
.filters {
  display: flex;
  gap: 8px;
}
.filters input {
  min-width: 0;
  flex: 1;
}
.filters input,
.filters select {
  margin: 0;
}
.filters select {
  max-width: 130px;
}
.new {
  background: var(--accent);
  color: var(--bg);
  font-size: 25px;
  font-weight: 400;
}
.list {
  display: grid;
  gap: 0;
  margin-top: 16px;
}
.session,
.folder {
  display: block;
  text-decoration: none;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  padding: 22px 0;
  text-align: left;
  background: none;
  color: var(--fg);
  width: 100%;
}
.session:hover,
.folder:hover {
  border-color: var(--accent);
}
h2,
h3 {
  font-size: 18px;
  margin: 10px 0 6px;
}
.folder h3 {
  margin: 0 0 6px;
}
.path {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  overflow-wrap: anywhere;
}
.state {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.time {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}
.dot {
  height: 7px;
  width: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.running {
  background: var(--accent);
  box-shadow: 0 0 0 3px #b4e4cc0c;
}
.dot.waiting,
.dot.answer_needed {
  background: #f0cf84;
}
.section-title {
  margin: 24px 0 0;
}
.home .empty {
  padding: 18px 0;
}
.empty {
  padding: 38px 22px;
}
</style>
