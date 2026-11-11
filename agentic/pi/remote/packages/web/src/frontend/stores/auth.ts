import { defineStore } from "pinia";
import { ref } from "vue";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
class ConnectionError extends Error {}
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
  const networkAvailable = ref(
    typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const connectionFailed = ref(false);
  const pending = ref(0);
  const reconnecting = ref(false);
  const pairingBusy = ref(false);
  const verifying = ref(false);
  const initializing = ref(true);
  let authGeneration = 0;
  let unlockInFlight: Promise<void> | undefined;
  let unlockGeneration = -1;
  let queuedGeneration: number | undefined;
  const name = ref("");
  let verifiedAt = 0;
  let background = 0;
  let lastPresence = 0;
  function clear() {
    authGeneration++;
    queuedGeneration = undefined;
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
    if (options.signal?.aborted) throw options.signal.reason;
    const controller = new AbortController();
    pendingRequests.add(controller);
    const foreground =
      !options.keepalive && !["/auth/presence", "/auth/lock"].includes(url);
    if (foreground) pending.value++;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new ConnectionError(
            "Can't connect to your Mac. Check your internet and Tailscale connection.",
          ),
        ),
      (url === "/sessions" && options.method === "POST") || url.endsWith("/recover")
        ? 65000
        : url.startsWith("/auth/") || url === "/me"
          ? 8000
          : options.method && options.method !== "GET"
            ? 30000
            : 20000,
    );
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        networkAvailable.value = false;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!networkAvailable.value)
        throw new ConnectionError(
          "You're offline. Connect to the internet and try again.",
        );
      const perform = async () => {
        const headers = new Headers(options.headers);
        if (csrf.value) headers.set("X-Pi-CSRF", csrf.value);
        if (options.body && !(options.body instanceof FormData))
          headers.set("Content-Type", "application/json");
        const result = await fetch(`/api/v1${url}`, {
          ...options,
          headers,
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = await result.json().catch((error) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (result.ok) throw error;
          return { error: "request_failed" };
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        online.value = true;
        connectionFailed.value = false;
        if (!result.ok) {
          if (result.status === 423 || result.status === 401) {
            pendingRequests.delete(controller);
            clear();
          }
          throw new Error(data.error ?? "request_failed");
        }
        return data as T;
      };
      return await Promise.race([perform(), cancelled]);
    } catch (e) {
      if (e instanceof TypeError || e instanceof ConnectionError) {
        online.value = false;
        connectionFailed.value = true;
        throw new ConnectionError(
          !networkAvailable.value
            ? "You're offline. Connect to the internet and try again."
            : "Can't connect to your Mac. Check your internet and Tailscale connection.",
        );
      }
      throw e;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
      pendingRequests.delete(controller);
      if (foreground) pending.value--;
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
    initializing.value = true;
    let connected = false;
    error.value = "";
    try {
      await me();
      if (paired.value) await request("/auth/lock", { method: "POST" });
      connected = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Can't connect to your Mac.";
    }
    clear();
    initializing.value = false;
    if (connected) await autoUnlock();
  }
  async function verify() {
    const expected = authGeneration;
    verifying.value = true;
    let submitted = false;
    error.value = "";
    try {
      const data = await request<{
        ceremony: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/auth/options", { method: "POST", body: "{}" });
      if (expected !== authGeneration || document.visibilityState !== "visible") return;
      const response = await startAuthentication({ optionsJSON: data.options });
      if (expected !== authGeneration || document.visibilityState !== "visible") return;
      submitted = true;
      await request("/auth/assert", {
        method: "POST",
        body: JSON.stringify({ ceremony: data.ceremony, response }),
      });
      await me();
      if (expected !== authGeneration || document.visibilityState !== "visible") return;
      unlocked.value = true;
      visible.value = true;
      verifiedAt = Date.now();
      lastPresence = Date.now();
    } catch (e) {
      if (expected === authGeneration && !unlocked.value)
        error.value =
          e instanceof Error &&
          (e.name === "NotAllowedError" ||
            (e.cause as Error | undefined)?.name === "NotAllowedError")
            ? "Tap Unlock to verify with your passkey."
            : e instanceof Error
              ? e.message
              : "Verification failed";
    } finally {
      if (
        submitted &&
        (expected !== authGeneration || document.visibilityState !== "visible")
      ) {
        await request("/auth/lock", { method: "POST", keepalive: true }).catch(
          () => {},
        );
      }
      verifying.value = false;
    }
  }
  function unlock(): Promise<void> {
    if (unlockInFlight) {
      if (unlockGeneration !== authGeneration) queuedGeneration = authGeneration;
      return unlockInFlight;
    }
    unlockGeneration = authGeneration;
    unlockInFlight = verify().finally(async () => {
      unlockInFlight = undefined;
      const queued = queuedGeneration;
      queuedGeneration = undefined;
      if (queued === authGeneration) await autoUnlock();
    });
    return unlockInFlight;
  }
  async function autoUnlock() {
    if (
      !initializing.value &&
      !connectionFailed.value &&
      networkAvailable.value &&
      paired.value &&
      !unlocked.value &&
      document.visibilityState === "visible" &&
      !location.hash
    )
      await unlock();
  }
  async function pair(secret: string, deviceName: string) {
    if (pairingBusy.value) return;
    pairingBusy.value = true;
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
    } finally {
      pairingBusy.value = false;
    }
  }
  async function reconnect() {
    if (reconnecting.value || initializing.value) return;
    reconnecting.value = true;
    networkAvailable.value =
      typeof navigator === "undefined" || navigator.onLine !== false;
    try {
      if (unlocked.value) await me();
      else await initialize();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Can't connect to your Mac.";
    } finally {
      reconnecting.value = false;
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
      await autoUnlock();
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
    } else if (!unlocked.value) {
      visible.value = true;
      void autoUnlock();
    } else void resumeForeground();
  }
  window.addEventListener("offline", () => {
    networkAvailable.value = false;
    online.value = false;
    connectionFailed.value = true;
    for (const controller of pendingRequests)
      controller.abort(
        new ConnectionError("You're offline. Connect to the internet and try again."),
      );
  });
  window.addEventListener("online", () => {
    networkAvailable.value = true;
  });
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
    networkAvailable,
    connectionFailed,
    pending,
    reconnecting,
    pairingBusy,
    reconnect,
    verifying,
    initializing,
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
