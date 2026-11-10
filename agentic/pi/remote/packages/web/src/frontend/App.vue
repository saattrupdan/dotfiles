<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import Icon from "./components/Icon.vue";
import { useAuth } from "./stores/auth.ts";
import { useSessions } from "./stores/sessions.ts";
const auth = useAuth();
const sessions = useSessions();
const pairing = ref(location.hash.slice(1));
const deviceName = ref("My iPhone");
const route = useRoute(),
  router = useRouter();
const current = computed(() =>
  sessions.sessions.find((s) => s.sessionId === route.params.id),
);
const headerTitle = computed(() =>
  route.path.startsWith("/session/") ? current.value?.name : "",
);
function back() {
  sessions.folder = route.path.startsWith("/session/") ? current.value?.cwd : undefined;
  void router.push("/");
}
const preventZoom = (event: Event) => event.preventDefault();
const preventPinch = (event: TouchEvent) => {
  if (event.touches.length > 1) event.preventDefault();
};
onMounted(() => {
  void auth.initialize();
  document.addEventListener("gesturestart", preventZoom, { passive: false });
  document.addEventListener("gesturechange", preventZoom, { passive: false });
  document.addEventListener("touchmove", preventPinch, { passive: false });
});
onUnmounted(() => {
  document.removeEventListener("gesturestart", preventZoom);
  document.removeEventListener("gesturechange", preventZoom);
  document.removeEventListener("touchmove", preventPinch);
});
watch(
  () => [auth.unlocked, auth.visible],
  ([unlocked, visible]) => {
    if (unlocked) pairing.value = "";
    if (!unlocked || !visible) sessions.disconnect();
    else sessions.resume();
  },
);
</script>
<template>
  <div class="shell">
    <header>
      <button
        v-if="auth.unlocked && auth.visible && route.path !== '/'"
        class="icon-button back"
        aria-label="Go back"
        title="Go back"
        @click="back"
      >
        <Icon name="back" />
      </button>
      <RouterLink
        to="/"
        class="brand"
        aria-label="Pi Remote"
        @click="sessions.folder = undefined"
      >
        <img
          src="/icons/pi.svg"
          alt=""
          width="44"
          height="44"
        />
        <span>Pi</span>
      </RouterLink>
      <span
        v-if="auth.unlocked && auth.visible"
        class="header-title"
        >{{ headerTitle }}</span
      >
      <RouterLink
        v-if="auth.unlocked && auth.visible"
        to="/settings"
        class="icon-button settings-link"
        aria-label="Settings"
        title="Settings"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="m9.6 3-.6 2.2-1.5.9-2.2-.6-2.4 4.1 1.6 1.6v1.6l-1.6 1.6 2.4 4.1 2.2-.6 1.5.9.6 2.2h4.8l.6-2.2 1.5-.9 2.2.6 2.4-4.1-1.6-1.6v-1.6l1.6-1.6-2.4-4.1-2.2.6-1.5-.9-.6-2.2z"
          />
          <circle
            cx="12"
            cy="12"
            r="3"
          />
        </svg>
      </RouterLink>
    </header>
    <div
      v-if="!auth.online"
      class="offline"
      role="status"
    >
      Mac offline. Check Tailscale.
    </div>
    <main
      v-if="auth.unlocked"
      v-show="auth.visible"
    >
      <RouterView />
    </main>
    <main
      v-if="!auth.unlocked || !auth.visible"
      class="unlock"
    >
      <img
        class="hero-mark"
        src="/icons/pi.svg"
        alt="Pi"
        width="160"
        height="160"
      />
      <h1>{{ auth.visible ? "Pi Remote" : "Locked" }}</h1>
      <template v-if="auth.visible">
        <template v-if="pairing">
          <label
            >Device name<input
              v-model="deviceName"
              maxlength="80"
          /></label>
          <button
            class="primary"
            @click="auth.pair(pairing, deviceName)"
          >
            Pair iPhone
          </button>
        </template>
        <button
          v-else
          class="primary"
          aria-label="Unlock with passkey"
          @click="auth.unlock"
        >
          Unlock
        </button>
        <details v-if="!auth.paired">
          <summary>Pair a device</summary>
          <p class="muted small">Run <code>pi-remote pair</code> on your Mac.</p>
          <input
            v-model="pairing"
            autocomplete="off"
            aria-label="Pairing code"
            placeholder="Pairing code"
          />
        </details>
        <p
          v-if="auth.error"
          class="error"
          role="alert"
        >
          {{ auth.error }}
        </p>
      </template>
    </main>
  </div>
</template>
<style scoped>
.shell {
  max-width: 800px;
  margin: auto;
  min-height: 100dvh;
  padding: 0 22px;
}
header {
  position: sticky;
  top: 0;
  z-index: 40;
  background: var(--bg);
  padding-top: env(safe-area-inset-top);
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 76px;
  border-bottom: 1px solid var(--line);
}
.header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  flex: 1;
  margin: 0 12px;
}
.back {
  margin-left: -10px;
}
.back + .brand {
  margin-left: 0;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: -11px;
  text-decoration: none;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.04em;
}
.brand img,
.hero-mark {
  border-radius: 0;
}
.settings-link {
  color: var(--muted);
  margin-right: -10px;
}
.unlock {
  max-width: 320px;
  margin: 8dvh auto 0;
  text-align: center;
}
.hero-mark {
  display: block;
  margin: 0 auto;
}
.unlock h1 {
  font-size: 24px;
  margin: 0 0 32px;
}
.unlock .primary {
  width: 100%;
}
.unlock label,
.unlock details {
  text-align: left;
}
.unlock details {
  margin-top: 24px;
}
.offline {
  margin-top: 16px;
  color: var(--muted);
  font-size: 13px;
}
</style>
