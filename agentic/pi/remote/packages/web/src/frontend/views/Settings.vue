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
    const subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    await auth.request("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
    note.value = "Generic completion and attention notifications enabled.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    notifying.value = false;
  }
}
</script>
<template>
  <section>
    <h1>Settings</h1>
    <div class="card">
      <h2>{{ auth.name }}</h2>
      <details class="privacy">
        <summary>Privacy</summary>
        <p class="muted small">
          Messages, images and drafts stay in memory. Locking or closing clears them.
          Background grace: 2 minutes.
        </p>
      </details>
      <button
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
        <span> Notifications are unavailable in this browser. </span>
        On iPhone, open Pi Remote from its Home Screen icon to enable notifications.
      </p>
      <p v-if="note">{{ note }}</p>
      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>
    </div>
    <h2>Devices</h2>
    <LoadingIndicator
      v-if="loading"
      label="Loading devices"
    />
    <div
      v-for="device in devices"
      :key="device.id"
      class="row device"
    >
      <div>
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
    <p class="muted small">Revoke removes access immediately. Pair again to return.</p>
    <button
      @click="
        auth.clear();
        auth.request('/auth/lock', { method: 'POST' }).catch(() => {});
      "
    >
      Lock
    </button>
  </section>
</template>
<style scoped>
h2 {
  font-size: 17px;
}
.privacy {
  margin: 10px 0 20px;
}
.device {
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.card {
  margin-bottom: 28px;
  background: none;
  padding: 0;
  border: 0;
}
</style>
