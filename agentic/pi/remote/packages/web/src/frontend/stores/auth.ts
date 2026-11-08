import { defineStore } from "pinia";
import { ref } from "vue";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
const pendingRequests = new Set<AbortController>();
const resets = new Set<() => void>();
export const onLock = (fn: () => void) => {
  resets.add(fn);
  return () => resets.delete(fn);
};
export const useAuth = defineStore("auth", () => {
  const paired = ref(false),
    unlocked = ref(false),
    visible = ref(true),
    online = ref(true),
    csrf = ref(""),
    error = ref("");
  const name = ref("");
  let verifiedAt = 0;
  let background = 0;
  let lastPresence = 0;
  function clear() {
    unlocked.value = false;
    visible.value = document.visibilityState === "visible";
    for (const request of pendingRequests) request.abort();
    pendingRequests.clear();
    for (const reset of resets) reset();
  }
  async function request<T = unknown>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    pendingRequests.add(controller);
    try {
      const headers = new Headers(options.headers);
      if (csrf.value) headers.set("X-Pi-CSRF", csrf.value);
      if (options.body && !(options.body instanceof FormData))
        headers.set("Content-Type", "application/json");
      const result = await fetch(`/api/v1${url}`, {
        ...options,
        signal: controller.signal,
        headers,
        credentials: "same-origin",
        cache: "no-store",
      });
      online.value = true;
      if (!result.ok) {
        const data = await result.json().catch(() => ({ error: "request_failed" }));
        if (result.status === 423 || result.status === 401) clear();
        throw new Error(data.error ?? "request_failed");
      }
      return await result.json();
    } catch (e) {
      if (e instanceof TypeError) online.value = false;
      throw e;
    } finally {
      pendingRequests.delete(controller);
    }
  }
  async function me() {
    const data = await request<{ paired: boolean; csrf?: string; device?: string }>(
      "/me",
    );
    paired.value = data.paired;
    csrf.value = data.csrf ?? "";
    name.value = data.device ?? "";
  }
  async function initialize() {
    try {
      await me();
      if (paired.value) await request("/auth/lock", { method: "POST" });
    } catch {
      error.value = "Mac unreachable. It must be awake with Tailscale connected.";
    }
    clear();
  }
  async function unlock() {
    error.value = "";
    try {
      const data = await request<{
        ceremony: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/auth/options", { method: "POST", body: "{}" });
      const response = await startAuthentication({ optionsJSON: data.options });
      await request("/auth/assert", {
        method: "POST",
        body: JSON.stringify({ ceremony: data.ceremony, response }),
      });
      await me();
      unlocked.value = true;
      visible.value = true;
      verifiedAt = Date.now();
      lastPresence = Date.now();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Verification failed";
    }
  }
  async function pair(secret: string, deviceName: string) {
    error.value = "";
    try {
      const data = await request<{
        ceremony: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>("/pairing/options", {
        method: "POST",
        body: JSON.stringify({ token: secret, name: deviceName }),
      });
      const response = await startRegistration({ optionsJSON: data.options });
      await request("/pairing/finish", {
        method: "POST",
        body: JSON.stringify({ ceremony: data.ceremony, response }),
      });
      history.replaceState(null, "", "/");
      await me();
      await unlock();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Pairing failed";
    }
  }
  async function presence(foreground: boolean) {
    if (!unlocked.value) return false;
    try {
      await request("/auth/presence", {
        method: "POST",
        body: JSON.stringify({ foreground }),
        keepalive: !foreground,
      });
      lastPresence = Date.now();
      return true;
    } catch {
      if (Date.now() - lastPresence > 45000) clear();
      return false;
    }
  }
  async function resumeForeground() {
    if (
      Date.now() - verifiedAt >= 15 * 60 * 1000 ||
      (background && Date.now() - background >= 120000)
    ) {
      clear();
      return;
    }
    const authorized = await presence(true);
    if (authorized && unlocked.value && document.visibilityState === "visible")
      visible.value = true;
  }
  function backgroundChanged() {
    if (document.visibilityState !== "visible") {
      visible.value = false;
      background = Date.now();
      void presence(false);
    } else if (!unlocked.value) visible.value = true;
    else void resumeForeground();
  }
  document.addEventListener("visibilitychange", backgroundChanged);
  window.addEventListener("pagehide", () => {
    clear();
    void request("/auth/lock", { method: "POST", keepalive: true }).catch(() => {});
  });
  setInterval(() => {
    if (!unlocked.value) return;
    if (Date.now() - verifiedAt >= 15 * 60 * 1000) {
      clear();
      return;
    }
    if (!visible.value) {
      if (Date.now() - background >= 120000) clear();
      else if (document.visibilityState === "visible") void resumeForeground();
    } else void presence(true);
  }, 15000);
  return {
    paired,
    unlocked,
    visible,
    online,
    csrf,
    error,
    name,
    request,
    initialize,
    unlock,
    pair,
    clear,
  };
});
