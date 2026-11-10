<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  back: "m14 6-6 6 6 6M8 12h13",
  send: "m5 12 7-7 7 7M12 5v15",
  image:
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l6-6 5 5 3-3 4 4M8 7h.01",
  folder: "M3 6h7l2 2h9v12H3ZM3 6V4h7l2 2h9v2",
  chevron: "m9 5 7 7-7 7",
  sliders: "M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m8 4v6",
  tools: "M8 7 3 12l5 5m8-10 5 5-5 5m-3-13-2 16",
  brain:
    "M12 5C8 1 4 4 5 7c-4 1-4 6-1 7-1 4 3 7 6 5l2 2 2-2c3 2 7-1 6-5 3-1 3-6-1-7 1-3-3-6-7-2Zm0 0v16",
  stop: "M6 6h12v12H6Z",
  plus: "M12 4v16M4 12h16",
  bookmark: "M6 3h12v18l-6-4-6 4Z",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  spinner: "M12 3a9 9 0 1 0 9 9",
};
</script>
<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :class="{ spinning: name === 'spinner' }"
  >
    <path :d="paths[name] || paths.folder" />
  </svg>
</template>
<style scoped>
svg {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
