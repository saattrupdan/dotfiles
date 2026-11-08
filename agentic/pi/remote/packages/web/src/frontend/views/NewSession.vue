<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../stores/auth.ts";
import { useSessions } from "../stores/sessions.ts";
const auth = useAuth();
const sessions = useSessions();
const router = useRouter();
const directory = ref<{
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
}>();
const favorites = ref<string[]>([]);
const error = ref("");
const busy = ref(false);
async function browse(path?: string) {
  try {
    directory.value = await auth.request(
      `/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(async () => {
  await browse();
  favorites.value = await auth.request("/favorites");
  await sessions.refresh();
});
async function favorite() {
  if (!directory.value) return;
  favorites.value = [...new Set([...favorites.value, directory.value.path])];
  await auth.request("/favorites", {
    method: "PUT",
    body: JSON.stringify(favorites.value),
  });
}
async function create() {
  if (!directory.value) return;
  busy.value = true;
  try {
    const result = await auth.request<{ sessionId: string }>("/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: directory.value.path }),
    });
    await router.push(`/session/${result.sessionId}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section>
    <p class="eyebrow">A fresh start</p>
    <h1>Choose a project</h1>
    <p class="muted">Pi runs on your Mac in the directory you choose.</p>
    <p
      v-if="error"
      class="error"
    >
      {{ error }}
    </p>
    <details>
      <summary>Favorites and recent projects</summary>
      <button
        v-for="cwd in [
          ...new Set([...favorites, ...sessions.sessions.map((s) => s.cwd)]),
        ].slice(0, 30)"
        :key="cwd"
        class="directory"
        @click="browse(cwd)"
      >
        {{ cwd }}
      </button>
    </details>
    <div
      v-if="directory"
      class="card browser"
    >
      <p class="path">{{ directory.path }}</p>
      <button
        v-if="directory.parent"
        class="directory"
        @click="browse(directory.parent!)"
      >
        .. Parent directory</button
      ><button
        v-for="child in directory.directories"
        :key="child.path"
        class="directory"
        @click="browse(child.path)"
      >
        {{ child.name }} /
      </button>
      <div class="row">
        <button @click="favorite">Favorite</button
        ><button
          class="primary"
          :disabled="busy"
          @click="create"
        >
          {{ busy ? "Starting Pi..." : "Start here" }}
        </button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.browser {
  margin-top: 20px;
}
.directory {
  display: block;
  text-align: left;
  width: 100%;
  margin: 7px 0;
  overflow-wrap: anywhere;
}
.path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--accent);
}
.browser .row {
  justify-content: space-between;
  margin-top: 20px;
}
</style>
