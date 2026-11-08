<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAuth } from "../stores/auth.ts";
const auth = useAuth();
const devices = ref<{ id: string; name: string; created: number }[]>([]);
const error = ref("");
const note = ref("");
async function refresh() {
  devices.value = await auth.request("/devices");
}
onMounted(() => refresh().catch((e) => (error.value = e.message)));
async function revoke(id: string) {
  try {
    await auth.request(`/devices/${id}`, { method: "DELETE" });
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function notifications() {
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
  }
}
</script>
<template>
  <section>
    <p class="eyebrow">Private access</p>
    <h1>Settings</h1>
    <div class="card">
      <h2>{{ auth.name }}</h2>
      <p class="muted">
        Two-minute background unlock grace. Transcripts, images and drafts are not saved
        on this phone.
      </p>
      <button @click="notifications">Enable notifications</button>
      <p class="small muted">
        Install this app on your Home Screen before enabling iPhone notifications.
      </p>
      <p v-if="note">{{ note }}</p>
      <p
        v-if="error"
        class="error"
      >
        {{ error }}
      </p>
    </div>
    <h2>Paired devices</h2>
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
        @click="revoke(device.id)"
      >
        Revoke
      </button>
    </div>
    <p class="muted small">
      Revocation ends access immediately. A new pairing is required to return.
    </p>
    <button
      @click="
        auth.clear();
        auth.request('/auth/lock', { method: 'POST' }).catch(() => {});
      "
    >
      Lock now
    </button>
  </section>
</template>
<style scoped>
h2 {
  font-size: 20px;
}
.device {
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.card {
  margin-bottom: 28px;
}
</style>
