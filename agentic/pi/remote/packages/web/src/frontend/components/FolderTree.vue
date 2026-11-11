<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { onLock, useAuth } from "../stores/auth.ts";
import Icon from "./Icon.vue";
const props = defineProps<{
  path: string;
  name: string;
  selected?: string;
  initial?: { name: string; path: string }[];
}>();
const emit = defineEmits<{ select: [path: string] }>();
const auth = useAuth();
const children = ref(props.initial);
const expanded = ref(Boolean(props.initial));
const loading = ref(false);
const error = ref("");
let generation = 0;
const reset = onLock(() => {
  generation++;
  children.value = undefined;
  expanded.value = false;
  error.value = "";
});
onUnmounted(() => {
  generation++;
  reset();
});
async function toggle() {
  expanded.value = !expanded.value;
  if (!expanded.value || children.value) return;
  const expected = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await auth.request<{
      directories: { name: string; path: string }[];
    }>(`/directories?path=${encodeURIComponent(props.path)}`);
    if (expected === generation && auth.unlocked) children.value = result.directories;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    if (expected === generation) loading.value = false;
  }
}
function select() {
  emit("select", props.path);
  if (!expanded.value) void toggle();
}
</script>
<template>
  <li
    role="treeitem"
    :aria-expanded="expanded"
    :aria-busy="loading"
    :aria-selected="selected === path"
  >
    <div
      class="folder-row"
      :class="{ selected: selected === path }"
    >
      <button
        class="icon-button expand"
        :class="{ expanded: expanded && !loading }"
        :disabled="loading"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${name}`"
        @click="toggle"
      >
        <Icon :name="loading ? 'spinner' : 'chevron'" />
      </button>
      <button
        class="choose"
        @click="select"
      >
        <Icon name="folder" /> <span>{{ name }}</span>
      </button>
    </div>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <ul
      v-if="expanded && children?.length"
      role="group"
    >
      <FolderTree
        v-for="child in children"
        :key="child.path"
        v-bind="child"
        :selected="selected"
        @select="emit('select', $event)"
      />
    </ul>
    <p
      v-else-if="expanded && children && !children.length"
      class="empty small muted"
    >
      No subfolders
    </p>
  </li>
</template>
<style scoped>
li {
  list-style: none;
}
ul {
  margin: 0 0 0 20px;
  padding: 0 0 0 12px;
  border-left: 1px solid var(--line);
}
.folder-row {
  display: flex;
  align-items: center;
  border-radius: 10px;
}
.folder-row.selected {
  background: var(--panel);
  color: var(--accent);
}
button {
  margin: 0;
  border: 0;
  background: none;
}
.choose {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  text-align: left;
  min-width: 0;
  padding: 12px 8px;
}
.choose span {
  overflow-wrap: anywhere;
}
.expand svg {
  transition: transform 0.15s;
}
.expand.expanded :deep(svg) {
  transform: rotate(90deg);
}
.empty {
  margin: 4px 0 12px 52px;
}
</style>
