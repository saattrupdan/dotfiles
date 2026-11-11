<script setup lang="ts">
import Icon from "./Icon.vue";
defineProps<{ label?: string; compact?: boolean }>();
</script>
<template>
  <div
    class="loading-indicator"
    :class="{ compact }"
    role="status"
    aria-live="polite"
  >
    <Icon name="spinner" />
    <span :class="{ 'sr-only': compact }">{{ label || "Loading" }}</span>
  </div>
</template>
<style scoped>
.loading-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  padding: 32px 12px;
  font-size: 14px;
}
.loading-indicator :deep(svg) {
  color: var(--accent);
}
.compact {
  display: inline-flex;
  padding: 0;
  min-width: 28px;
}
</style>
