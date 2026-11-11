<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { onLock, useAuth } from "../stores/auth.ts";
import { useSessions } from "../stores/sessions.ts";
import FolderTree from "../components/FolderTree.vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Icon from "../components/Icon.vue";
const auth = useAuth();
const sessions = useSessions();
const router = useRouter();
const root = ref<{ path: string; directories: { name: string; path: string }[] }>();
const selected = ref("");
const error = ref("");
const busy = ref(false);
const loading = ref(true);
const uncertain = ref(false);
let generation = 0;
const reset = onLock(() => {
  generation++;
  root.value = undefined;
  selected.value = "";
  error.value = "";
});
onUnmounted(() => {
  generation++;
  reset();
});
onMounted(load);
async function load() {
  loading.value = true;
  error.value = "";
  const expected = generation;
  try {
    const result = await auth.request<NonNullable<typeof root.value>>("/directories");
    if (!auth.unlocked || expected !== generation) return;
    root.value = result;
    selected.value = result.path;
  } catch (e) {
    if (expected === generation) error.value = (e as Error).message;
  } finally {
    if (expected === generation) loading.value = false;
  }
}
async function create() {
  if (!auth.networkAvailable) {
    error.value = "You're offline. Reconnect before starting Pi.";
    return;
  }
  if (!selected.value || busy.value || uncertain.value) return;
  busy.value = true;
  const expected = generation;
  let created = false;
  error.value = "";
  try {
    const result = await auth.request<{ sessionId: string }>("/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: selected.value }),
    });
    if (!auth.unlocked || expected !== generation) return;
    created = true;
    if (!result.sessionId)
      throw new Error(
        "Pi startup returned no conversation. Check your Mac before starting again.",
      );
    await sessions.detail(result.sessionId);
    if (!auth.unlocked || expected !== generation) return;
    await router.push(`/session/${result.sessionId}`);
  } catch (e) {
    error.value = (e as Error).message;
    uncertain.value =
      created ||
      /unknown|timed out|launch_timeout|fetch|network|connect|offline|returned no conversation|internal_error/i.test(
        error.value,
      );
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section>
    <h1>Choose a folder</h1>
    <LoadingIndicator
      v-if="loading"
      label="Loading folders"
    />
    <button
      v-if="!root && error"
      @click="load"
    >
      Try again
    </button>
    <ul
      v-if="root"
      class="folder-tree"
      role="tree"
      aria-label="Folders"
    >
      <FolderTree
        :path="root.path"
        :name="root.path.split('/').at(-1) || root.path"
        :initial="root.directories"
        :selected="selected"
        @select="selected = $event"
      />
    </ul>
    <div class="start-panel">
      <p class="small muted path">{{ selected }}</p>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <p
        v-if="uncertain"
        class="small error"
      >
        Check Pi on your Mac before starting another session.
      </p>
      <button
        class="primary start"
        :disabled="busy || loading || uncertain || !selected"
        :aria-busy="busy"
        @click="create"
      >
        <Icon
          v-if="busy"
          name="spinner"
        />{{ busy ? "Starting Pi..." : "Start here" }}
      </button>
    </div>
  </section>
</template>
<style scoped>
.folder-tree {
  margin: 20px 0;
  padding: 0;
}
.start-panel {
  position: sticky;
  bottom: 0;
  padding: 16px 0;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  background: var(--bg);
  border-top: 1px solid var(--line);
}
.path {
  overflow-wrap: anywhere;
  margin: 0 0 12px;
}
.start {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
}
</style>
