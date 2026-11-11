<script setup lang="ts">
import { onMounted, ref } from "vue";
import LoadingIndicator from "../components/LoadingIndicator.vue";
import Icon from "../components/Icon.vue";
import { useAuth } from "../stores/auth.ts";
const auth = useAuth();
const devices = ref<{ id: string; name: string; created: number }[]>([]);
const error = ref("");
const note = ref("");
const loading = ref(true);
const notifying = ref(false);
const revoking = ref("");
const notificationsSupported =
  typeof Notification !== "undefined" &&
  typeof PushManager !== "undefined" &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator;
async function refresh() {
  loading.value = true;
  try {
    devices.value = await auth.request("/devices");
  } finally {
    loading.value = false;
  }
}
onMounted(() => refresh().catch((e) => (error.value = e.message)));
async function revoke(id: string) {
  if (revoking.value) return;
  revoking.value = id;
  try {
    await auth.request(`/devices/${id}`, { method: "DELETE" });
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    revoking.value = "";
  }
}
async function notifications() {
  if (notifying.value) return;
  error.value = "";
  note.value = "";
  if (!notificationsSupported) {
    error.value =
      "Notifications are unavailable here. On iPhone, open Pi Remote " +
      "from its Home Screen icon.";
    return;
  }
  notifying.value = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error("Notification permission was not granted.");
    const worker = await navigator.serviceWorker.ready;
    const { key } = await auth.request<{ key: string }>("/push/key");
    const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
    const applicationServerKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const subscription =
      (await worker.pushManager.getSubscription()) ??
      (await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      }));
    await auth.request("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
    note.value = "Push notifications enabled.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    notifying.value = false;
  }
}
</script>
<template>
  <section class="settings">
    <h1>Settings</h1>
    <div class="identity card">
      <span class="setting-icon"><Icon name="phone" /></span>
      <div>
        <h2>{{ auth.name || "Your phone" }}</h2>
        <p class="small muted">Connected to your Mac</p>
      </div>
      <span
        class="connected"
        aria-label="Connected"
        ><Icon name="check"
      /></span>
    </div>
    <section
      class="card settings-group"
      aria-labelledby="notifications-heading"
    >
      <div class="group-heading">
        <span class="setting-icon"><Icon name="bell" /></span>
        <div>
          <h2 id="notifications-heading">Notifications</h2>
          <p class="small muted">When Pi finishes, fails or needs your input.</p>
        </div>
      </div>
      <button
        class="primary notification-button"
        :disabled="!notificationsSupported || notifying"
        :aria-busy="notifying"
        @click="notifications"
      >
        <Icon
          v-if="notifying"
          name="spinner"
        />{{ notifying ? "Enabling..." : "Enable notifications" }}
      </button>
      <p
        v-if="!notificationsSupported"
        class="small muted"
      >
        Notifications are unavailable in this browser. On iPhone, open Pi Remote from
        its Home Screen icon to enable notifications.
      </p>
      <p
        v-if="note"
        class="small success"
        role="status"
      >
        <Icon name="check" />{{ note }}
      </p>
    </section>
    <section
      class="card settings-group"
      aria-labelledby="devices-heading"
    >
      <div class="group-heading">
        <span class="setting-icon"><Icon name="phone" /></span>
        <div>
          <h2 id="devices-heading">Devices</h2>
          <p class="small muted">Manage your paired devices.</p>
        </div>
      </div>
      <LoadingIndicator
        v-if="loading"
        label="Loading devices"
      />
      <div
        v-for="device in devices"
        :key="device.id"
        class="device"
      >
        <div class="device-name">
          <strong>{{ device.name }}</strong>
          <p class="small muted">
            Paired {{ new Date(device.created).toLocaleDateString() }}
          </p>
        </div>
        <button
          class="danger"
          :disabled="Boolean(revoking)"
          :aria-busy="revoking === device.id"
          @click="revoke(device.id)"
        >
          <Icon
            v-if="revoking === device.id"
            name="spinner"
          />{{ revoking === device.id ? "Revoking..." : "Revoke" }}
        </button>
      </div>
      <p
        v-if="!loading && !devices.length"
        class="small muted"
      >
        No paired devices.
      </p>
    </section>
    <p
      v-if="error"
      class="error small"
      role="alert"
    >
      {{ error }}
    </p>
    <button
      class="close-sessions"
      @click="
        auth.clear();
        auth.request('/auth/lock', { method: 'POST' }).catch(() => {});
      "
    >
      <Icon name="exit" />Close sessions
    </button>
  </section>
</template>
<style scoped>
.settings {
  max-width: 640px;
  margin: 0 auto;
}
.identity {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}
h2 {
  font-size: 16px;
  margin: 0;
  letter-spacing: -0.01em;
}
p {
  margin: 4px 0 0;
}
.setting-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: #25d36612;
  color: var(--accent);
  flex-shrink: 0;
}
.connected {
  margin-left: auto;
  color: var(--accent);
}
.connected :deep(svg) {
  width: 20px;
  height: 20px;
}
.settings-group {
  margin-bottom: 16px;
}
.group-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 18px;
}
.notification-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
}
.notification-button + p {
  margin-top: 12px;
}
.device {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 0;
  border-top: 1px solid var(--line);
}
.device:last-child {
  padding-bottom: 0;
}
.device-name {
  min-width: 0;
}
.device strong {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.device button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.success {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
}
.success :deep(svg) {
  width: 16px;
  height: 16px;
}
.close-sessions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  color: var(--muted);
  margin-top: 24px;
}
</style>
