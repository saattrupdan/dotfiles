<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { useAuth } from "./stores/auth.ts";
import { useSessions } from "./stores/sessions.ts";
const auth = useAuth();
const sessions = useSessions();
const pairing = ref(location.hash.slice(1));
const deviceName = ref("My iPhone");
onMounted(() => auth.initialize());
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
      <RouterLink
        to="/"
        class="brand"
        ><span class="mark">pi</span> Remote</RouterLink
      ><RouterLink
        v-if="auth.unlocked && auth.visible"
        to="/settings"
        class="quiet"
        >Settings</RouterLink
      >
    </header>
    <div
      v-if="!auth.online"
      class="offline"
    >
      Mac unreachable. Check Tailscale and whether the Mac is awake.
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
      <div class="hero-mark">pi</div>
      <p class="eyebrow">YOUR MAC. YOUR CONVERSATIONS.</p>
      <h1>
        {{ auth.visible ? "Pick up where you left off." : "See you in a moment." }}
      </h1>
      <p class="muted">
        Private access over Tailscale. Conversations stay on your Mac.
      </p>
      <template v-if="auth.visible">
        <template v-if="pairing">
          <label
            >Device name<input
              v-model="deviceName"
              maxlength="80" /></label
          ><button
            class="primary"
            @click="auth.pair(pairing, deviceName)"
          >
            Pair this iPhone
          </button> </template
        ><button
          v-else
          class="primary"
          @click="auth.unlock"
        >
          Unlock with passkey
        </button>
        <details v-if="!auth.paired">
          <summary>Pair a new device</summary>
          <p>
            Run <code>pi-remote pair</code> on your Mac, then scan the QR code or paste
            its pairing code here.
          </p>
          <input
            v-model="pairing"
            autocomplete="off"
            placeholder="One-time pairing code"
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
    <footer>Private by connection. Present while unlocked.</footer>
  </div>
</template>
<style scoped>
.shell {
  max-width: 820px;
  margin: auto;
  min-height: 100dvh;
  padding: 0 22px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 0;
  border-bottom: 1px solid var(--line);
}
.brand {
  font-weight: 700;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 10px;
}
.mark {
  background: var(--accent);
  color: var(--bg);
  border-radius: 10px;
  padding: 5px 9px;
  font-family: Georgia, serif;
  font-size: 24px;
}
.unlock {
  max-width: 470px;
  margin: 12vh auto 80px;
}
.hero-mark {
  font-family: Georgia, serif;
  color: var(--accent);
  font-size: 78px;
  line-height: 1;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.2em;
  margin-top: 30px;
}
h1 {
  font-size: clamp(32px, 8vw, 46px);
  line-height: 1.1;
  letter-spacing: -0.04em;
}
.unlock .primary {
  width: 100%;
  margin-top: 20px;
}
footer {
  color: var(--muted);
  font-size: 11px;
  padding: 30px 0;
}
.offline {
  margin-top: 16px;
  background: #554221;
  padding: 12px;
  border-radius: 12px;
  font-size: 13px;
}
details {
  margin-top: 24px;
  font-size: 13px;
}
</style>
