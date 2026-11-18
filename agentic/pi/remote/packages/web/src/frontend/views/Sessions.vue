<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, onBeforeRouteLeave } from "vue-router";
import { isUsersDirectory } from "../lib/session-paths.ts";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import { isUntitled } from "../lib/conversation-name.ts";
import Icon from "../components/Icon.vue";
import { useSessions } from "../stores/sessions.ts";
import { conversationStatus } from "../../../../protocol/src/session-status.ts";
const store = useSessions();
const folder = computed(() => store.folder);
const search = ref("");
const filter = ref("all");
const browseError = ref("");
const browsing = ref(false);
const markingRead = ref(false);
const markReadError = ref("");
const hasFinished = computed(() =>
  store.sessions.some((session) => conversationStatus(session) === "finished"),
);
async function markAllRead() {
  if (markingRead.value) return;
  markingRead.value = true;
  markReadError.value = "";
  try {
    await store.acknowledgeAllFinished();
  } catch (e) {
    markReadError.value = (e as Error).message;
  } finally {
    markingRead.value = false;
  }
}
const error = computed(() =>
  folder.value === undefined ? store.homeError : browseError.value,
);
const loading = computed(
  () => browsing.value || (folder.value === undefined && store.homeLoading),
);
const root = ref<HTMLElement>();
let restoring: typeof store.homePosition;
function captureHome() {
  if (folder.value !== undefined || !store.homeLoaded) return;
  const edge = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  const row = Array.from(
    root.value?.querySelectorAll<HTMLElement>("[data-home-key]") ?? [],
  ).find((row) => row.getBoundingClientRect().bottom > edge);
  store.homePosition = {
    top: window.scrollY,
    search: search.value,
    anchor: row
      ? { key: row.dataset.homeKey!, offset: row.getBoundingClientRect().top }
      : undefined,
  };
}
function restoreHome() {
  if (!restoring || folder.value !== undefined || !store.homeLoaded) return;
  const anchor = restoring.anchor;
  const row =
    anchor &&
    Array.from(root.value?.querySelectorAll<HTMLElement>("[data-home-key]") ?? []).find(
      (row) => row.dataset.homeKey === anchor.key,
    );
  const top =
    row && anchor
      ? window.scrollY + row.getBoundingClientRect().top - anchor.offset
      : restoring.top;
  window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
}
function cancelRestore() {
  restoring = undefined;
}
function openFolder(cwd: string) {
  captureHome();
  cancelRestore();
  store.folder = cwd;
}
onBeforeRouteLeave(() => {
  captureHome();
  cancelRestore();
});
let navigation = 0;
async function browse(cwd?: string) {
  const expected = ++navigation;
  if (cwd !== undefined && !isUsersDirectory(cwd)) {
    store.folder = undefined;
    return;
  }

  restoring = cwd === undefined ? store.homePosition : undefined;
  search.value = restoring?.search ?? "";
  filter.value = "all";
  browseError.value = "";
  browsing.value = true;
  await nextTick();
  if (expected !== navigation) return;
  if (restoring) restoreHome();
  else window.scrollTo({ top: 0, behavior: "instant" });
  try {
    if (cwd === undefined) await store.loadFolders();
    else await store.refresh(cwd);
  } catch (e) {
    if (expected === navigation) browseError.value = (e as Error).message;
  } finally {
    if (expected === navigation) {
      browsing.value = false;
      await nextTick();
      if (expected === navigation) {
        restoreHome();
        cancelRestore();
      }
    }
  }
}
onMounted(() => {
  store.connect("");
  restoreHome();
  window.addEventListener("wheel", cancelRestore, { passive: true });
  window.addEventListener("touchmove", cancelRestore, { passive: true });
  window.addEventListener("keydown", cancelRestore);
});
watch(folder, browse, { immediate: true });
onUnmounted(() => {
  navigation++;
  cancelRestore();
  window.removeEventListener("wheel", cancelRestore);
  window.removeEventListener("touchmove", cancelRestore);
  window.removeEventListener("keydown", cancelRestore);
  store.disconnect(true);
});
const folders = computed(() =>
  store.folders
    .filter(
      (entry) =>
        isUsersDirectory(entry.cwd) &&
        entry.cwd.toLowerCase().includes(search.value.toLowerCase()),
    )
    .sort(
      (a, b) =>
        basename(a.cwd).localeCompare(basename(b.cwd), undefined, {
          sensitivity: "base",
        }) || a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" }),
    ),
);
const activeStates = new Set(["idle", "running", "waiting", "answer_needed"]);
const showListing = computed(
  () => !loading.value || (folder.value === undefined && store.homeLoaded),
);
const filtered = computed(() =>
  (folder.value === undefined ? store.homeListing : store.listing).filter(
    (session) =>
      !isUntitled(session.name) &&
      isUsersDirectory(session.cwd) &&
      (filter.value === "all" || conversationStatus(session) === filter.value) &&
      `${session.name} ${session.sessionId} ${session.cwd}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
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
  <section
    ref="root"
    :aria-busy="loading"
  >
    <div class="row heading">
      <h1>Conversations</h1>
      <div class="row heading-actions">
        <button
          class="icon-button"
          aria-label="Mark all as read"
          title="Mark all as read"
          :disabled="markingRead || !hasFinished"
          :aria-busy="markingRead"
          @click="markAllRead"
        >
          <Icon :name="markingRead ? 'spinner' : 'check'" />
        </button>
        <RouterLink
          to="/new"
          class="new icon-button"
          aria-label="New conversation"
          title="New conversation"
          >+</RouterLink
        >
      </div>
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
        @input="cancelRestore"
      />
      <select
        v-if="folder !== undefined"
        v-model="filter"
        aria-label="Filter state"
      >
        <option value="all">All</option>
        <option
          v-for="state in ['needs_input', 'failed', 'finished', 'running', 'idle']"
          :key="state"
          :value="state"
        >
          {{ state.replace("_", " ") }}
        </option>
      </select>
    </div>
    <p
      v-if="markReadError"
      class="error"
      role="alert"
    >
      {{ markReadError }}
    </p>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <button
      v-if="error"
      @click="browse(folder)"
    >
      Try again
    </button>
    <LoadingIndicator
      v-if="!showListing"
      label="Loading conversations"
    />
    <div
      v-if="showListing && folder === undefined"
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
            :data-home-key="'session:' + session.sessionId"
          >
            <div class="row">
              <span :class="['dot', conversationStatus(session)]" />
              <span class="state">{{
                conversationStatus(session).replace("_", " ")
              }}</span>
            </div>
            <h3>{{ session.name || "Saved conversation" }}</h3>
            <p class="path">{{ session.cwd }}</p>
          </RouterLink>
          <LoadingIndicator
            v-if="loading && !active.length"
            label="Loading active sessions"
            compact
          />
          <p
            v-else-if="!active.length && !error"
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
            :data-home-key="'folder:' + entry.cwd"
            @click="openFolder(entry.cwd)"
          >
            <div class="row">
              <h3>{{ basename(entry.cwd) }}</h3>
              <span class="time">{{ entry.count }}</span>
            </div>
            <p class="path">{{ entry.cwd }}</p>
          </button>
          <LoadingIndicator
            v-if="loading && !folders.length"
            label="Loading folders"
            compact
          />
          <p
            v-else-if="!folders.length && !error"
            class="empty muted"
          >
            {{ search ? "No matches" : "No conversations in the last 7 days" }}
          </p>
        </div>
      </section>
    </div>
    <div
      v-else-if="showListing"
      class="list"
    >
      <RouterLink
        v-for="session in filtered"
        :key="session.sessionId"
        :to="`/session/${session.sessionId}`"
        class="session"
      >
        <div class="row">
          <span :class="['dot', conversationStatus(session)]" /><span class="state">{{
            conversationStatus(session).replace("_", " ")
          }}</span
          ><span class="time">{{
            new Date(session.lastActivity).toLocaleDateString()
          }}</span>
        </div>
        <h2>{{ session.name || "Saved conversation" }}</h2>
      </RouterLink>
      <p
        v-if="!filtered.length && !error"
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
.heading-actions {
  gap: 8px;
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
  background: #f0cf84;
}
.dot.finished {
  background: var(--accent);
}
.dot.failed {
  background: #ff6b6b;
}
.dot.needs_input {
  background: #c4a0ff;
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
