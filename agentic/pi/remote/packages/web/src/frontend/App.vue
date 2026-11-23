<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import LoadingIndicator from "./components/LoadingIndicator.vue";
import { isUntitled } from "./lib/conversation-name.ts";
import { activateNotifications } from "./lib/notifications.ts";
import Icon from "./components/Icon.vue";
import { useAuth } from "./stores/auth.ts";
import { useSessions } from "./stores/sessions.ts";
import { useOffline } from "./stores/offline.ts";
import { windowProof } from "./lib/history-window.ts";
import type { HistoryPage } from "../../../protocol/src/index.ts";
const auth = useAuth();
const notificationError = ref("");
let notificationSync = false;
async function syncNotifications() {
  if (notificationSync || !auth.unlocked || !auth.visible) return;
  notificationSync = true;
  try {
    await activateNotifications(
      auth.request,
      () => auth.unlocked && auth.visible && document.visibilityState === "visible",
    );
    notificationError.value = "";
  } catch {
    if (auth.unlocked && auth.visible)
      notificationError.value =
        "Notifications could not reconnect. Enable notifications in Settings.";
  } finally {
    notificationSync = false;
  }
}
const sessions = useSessions();
const offline = useOffline();
offline.begin(true);
void offline.reload();
let refreshingCopy = false;
async function refreshCopy() {
  if (
    refreshingCopy ||
    !offline.active ||
    !auth.unlocked ||
    !auth.online ||
    !auth.visible
  )
    return;
  refreshingCopy = true;
  const target = String(route.params.id ?? "");
  offline.requestRefresh();
  try {
    if (target) {
      const saved = offline.copies.find((row) => row.sessionId === target);
      await Promise.all([sessions.detail(target), sessions.history(target)]);
      if (saved?.messages.length) {
        const proof = await windowProof(saved.messages);
        if (proof) {
          const page = await auth.request<HistoryPage>(
            `/sessions/${target}/history?window=latest${proof}`,
          );
          const first = page.messages[0]?.remoteHistoryKey;
          const position = saved.messages.findIndex(
            (m) => m.remoteHistoryKey === first,
          );
          if (page.anchorFound && position >= 0)
            sessions.messages[target] = [
              ...saved.messages.slice(0, position),
              ...page.messages,
            ];
        }
      }
    } else await sessions.loadFolders();
    if (auth.unlocked && auth.online && target === String(route.params.id ?? ""))
      offline.complete();
  } catch {
    /* Keep the saved reader until fresh live state is available. */
  } finally {
    refreshingCopy = false;
  }
}
const offlineTimer = setInterval(() => {
  if (!auth.visible) return;
  if (offline.active) {
    void auth.reconnect().then(refreshCopy);
  } else void offline.synchronize();
}, 15000);
const connectionWarning = ref(false);
const connectionRecovering = computed(
  () => auth.connectionFailed && !connectionWarning.value,
);
let connectionWarningTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [auth.connectionFailed, auth.visible],
  ([failed, visible]) => {
    if (connectionWarningTimer) clearTimeout(connectionWarningTimer);
    connectionWarningTimer = undefined;
    connectionWarning.value = false;
    if (failed && visible)
      connectionWarningTimer = setTimeout(() => {
        connectionWarningTimer = undefined;
        connectionWarning.value = auth.connectionFailed && auth.visible;
      }, 20000);
  },
  { immediate: true },
);

const pairing = ref(location.hash.slice(1));
const deviceName = ref("My iPhone");
const route = useRoute(),
  router = useRouter();
const current = computed(() =>
  offline.active
    ? offline.copies.find((s) => s.sessionId === route.params.id)
    : sessions.sessions.find((s) => s.sessionId === route.params.id),
);
const headerTitle = computed(() =>
  route.path.startsWith("/session/")
    ? isUntitled(current.value?.name)
      ? "New conversation"
      : current.value?.name
    : "",
);
function back() {
  sessions.folder = undefined;
  void router.push("/");
}
async function retryConnection() {
  await auth.reconnect();
  if (auth.unlocked && auth.online) await sessions.resume();
}
const preventZoom = (event: Event) => event.preventDefault();
const preventPinch = (event: TouchEvent) => {
  if (event.touches.length > 1) event.preventDefault();
};

async function openNotification(event: MessageEvent) {
  if (
    event.origin !== location.origin ||
    event.data?.type !== "notification-open" ||
    typeof event.data.url !== "string" ||
    !/^\/session\/[0-9a-f-]{36}$/.test(event.data.url)
  )
    return;
  const url = event.data.url,
    id = event.data.id;
  try {
    await router.isReady();
    await router.push(url);
    if (router.currentRoute.value.path === url)
      event.source?.postMessage({ type: "notification-opened", id });
  } catch {
    notificationError.value = "Could not open that conversation. Open it from Home.";
  }
}
let notificationListening = false;
function notificationReady() {
  const worker = navigator.serviceWorker;
  if (!worker || !notificationListening || document.visibilityState !== "visible")
    return;
  if (worker.controller) worker.controller.postMessage({ type: "notification-ready" });
  else
    void worker
      .getRegistration()
      .then((registration) => {
        if (notificationListening)
          registration?.active?.postMessage({ type: "notification-ready" });
      })
      .catch(() => {});
}
const previousRestoration = window.history.scrollRestoration;
onMounted(() => {
  window.history.scrollRestoration = "manual";
  notificationListening = true;
  navigator.serviceWorker?.addEventListener("message", openNotification);
  window.addEventListener("focus", notificationReady);
  document.addEventListener("visibilitychange", notificationReady);
  navigator.serviceWorker?.addEventListener("controllerchange", notificationReady);
  notificationReady();
  void auth.initialize();
  window.addEventListener("focus", syncNotifications);
  navigator.serviceWorker?.addEventListener("controllerchange", syncNotifications);
  document.addEventListener("gesturestart", preventZoom, { passive: false });
  document.addEventListener("gesturechange", preventZoom, { passive: false });
  document.addEventListener("touchmove", preventPinch, { passive: false });
});
onUnmounted(() => {
  clearInterval(offlineTimer);
  notificationListening = false;
  window.removeEventListener("focus", notificationReady);
  document.removeEventListener("visibilitychange", notificationReady);
  navigator.serviceWorker?.removeEventListener("controllerchange", notificationReady);
  if (connectionWarningTimer) clearTimeout(connectionWarningTimer);
  window.history.scrollRestoration = previousRestoration;
  window.removeEventListener("focus", syncNotifications);
  navigator.serviceWorker?.removeEventListener("controllerchange", syncNotifications);
  navigator.serviceWorker?.removeEventListener("message", openNotification);
  document.removeEventListener("gesturestart", preventZoom);
  document.removeEventListener("gesturechange", preventZoom);
  document.removeEventListener("touchmove", preventPinch);
});
watch(
  () => [auth.unlocked, auth.visible, auth.online],
  ([unlocked, visible, online]) => {
    if (unlocked) pairing.value = "";
    if (!unlocked || !visible || !online) sessions.disconnect();
    else {
      if (offline.active) void refreshCopy();
      else {
        sessions.resume();
        if (!route.path.startsWith("/session/")) offline.complete();
      }
      void offline.synchronize();
      void syncNotifications();
    }
  },
  { immediate: true, flush: "sync" },
);
watch(
  () => offline.active,
  (active) => {
    if (active) void refreshCopy();
  },
);
watch(
  () => [auth.initializing, auth.paired, auth.connectionFailed],
  () => {
    if (!auth.initializing && !auth.paired && !auth.connectionFailed && auth.online)
      offline.complete();
  },
);
watch(
  () => auth.connectionFailed,
  (failed) => {
    if (failed) offline.failed();
  },
);
watch(
  () => offline.revision,
  () => {
    if (!refreshingCopy) void auth.reconnect().then(refreshCopy);
  },
);
watch(
  () => route.path,
  () => {
    if (!offline.active && route.path.startsWith("/session/")) offline.begin();
  },
);
</script>
<template>
  <div class="shell">
    <header>
      <button
        v-if="(auth.unlocked || offline.active) && auth.visible && route.path !== '/'"
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
      </RouterLink>
      <span
        v-if="(auth.unlocked || offline.active) && auth.visible"
        class="header-title"
        >{{ headerTitle }}</span
      >
      <span
        v-if="offline.active && auth.visible"
        class="offline-badge"
        role="status"
        >Offline</span
      >
      <LoadingIndicator
        v-if="
          !offline.active &&
          (auth.pending || connectionRecovering) &&
          !auth.initializing &&
          !auth.verifying &&
          auth.visible
        "
        compact
        :label="connectionRecovering ? 'Reconnecting...' : 'Loading'"
      />
      <RouterLink
        v-if="(auth.unlocked || offline.active) && auth.visible"
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
    <section
      v-if="connectionWarning && !auth.initializing && auth.visible && !offline.active"
      class="connection-error"
      :class="{ compact: auth.unlocked }"
      role="alert"
    >
      <div
        class="connection-symbol"
        aria-hidden="true"
      >
        <Icon name="connection" />
      </div>
      <h1>{{ auth.networkAvailable ? "Can't reach your Mac" : "You're offline" }}</h1>
      <p>Check your internet and Tailscale connection, then try again.</p>
      <button
        class="primary"
        :disabled="auth.reconnecting"
        :aria-busy="auth.reconnecting"
        @click="retryConnection"
      >
        <Icon
          v-if="auth.reconnecting"
          name="spinner"
        />{{ auth.reconnecting ? "Connecting..." : "Try again" }}
      </button>
    </section>
    <p
      v-if="auth.unlocked && auth.visible && notificationError"
      class="connection-error"
      role="alert"
    >
      {{ notificationError }}
    </p>
    <main
      v-if="auth.unlocked || offline.active"
      v-show="auth.visible"
      :class="{ chat: route.path.startsWith('/session/') }"
    >
      <RouterView />
    </main>
    <main
      v-if="
        !offline.active &&
        (!auth.unlocked || !auth.visible) &&
        (!connectionWarning || auth.initializing || !auth.visible)
      "
      class="unlock"
    >
      <img
        class="hero-mark"
        src="/icons/pi.svg"
        alt="Pi"
        width="160"
        height="160"
      />
      <h1>Pi Remote</h1>
      <LoadingIndicator
        v-if="auth.initializing || auth.verifying || connectionRecovering"
        :label="connectionRecovering ? 'Reconnecting...' : 'Connecting to your Mac'"
      />
      <template
        v-if="
          auth.visible && !auth.initializing && !auth.verifying && !connectionRecovering
        "
      >
        <template v-if="pairing">
          <label
            >Device name<input
              v-model="deviceName"
              maxlength="80"
          /></label>
          <button
            class="primary"
            :disabled="auth.pairingBusy"
            :aria-busy="auth.pairingBusy"
            @click="auth.pair(pairing, deviceName)"
          >
            <Icon
              v-if="auth.pairingBusy"
              name="spinner"
            />{{ auth.pairingBusy ? "Pairing..." : "Pair iPhone" }}
          </button>
        </template>
        <button
          v-else-if="auth.paired"
          class="primary"
          aria-label="Open sessions"
          :disabled="auth.verifying || auth.initializing"
          :aria-busy="auth.verifying"
          @click="auth.unlock"
        >
          <Icon
            v-if="auth.verifying"
            name="spinner"
          />{{ auth.verifying ? "Opening..." : "Open sessions" }}
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
  padding: 0 12px;
}
header {
  position: sticky;
  top: 0;
  z-index: 40;
  background: var(--panel);
  margin: 0 -12px;
  padding-left: 12px;
  padding-right: 12px;
  padding-top: env(safe-area-inset-top);
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: calc(var(--header-height) + env(safe-area-inset-top));
  border-bottom: 1px solid var(--line);
}
.offline-badge {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px 6px;
  margin-right: 8px;
}
.header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  flex: 1;
  margin: 0 8px;
  font-size: 16px;
  font-weight: 600;
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
  margin-left: 0;
  padding-left: 4px;
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
.connection-error {
  margin: 10dvh auto 24px;
  max-width: 390px;
  padding: 32px 24px;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: radial-gradient(ellipse at top, #25d36613, transparent 75%), var(--panel);
  box-shadow: 0 16px 56px #0002;
}
.connection-symbol {
  display: inline-flex;
  padding: 16px;
  color: var(--accent);
  background: #25d36612;
  border-radius: 20px;
}
.connection-symbol :deep(svg) {
  width: 30px;
  height: 30px;
}
.connection-error h1 {
  margin: 20px 0 8px;
  font-size: 23px;
  letter-spacing: -0.03em;
}
.connection-error p {
  color: var(--muted);
  line-height: 1.6;
  font-size: 14px;
}
.connection-error button,
.unlock .primary {
  display: inline-flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
}
.connection-error.compact {
  margin: 16px auto;
  padding: 16px;
}
.compact .connection-symbol {
  display: none;
}
.compact h1 {
  margin-top: 0;
  font-size: 18px;
}
main.chat {
  padding: 0;
}
</style>
