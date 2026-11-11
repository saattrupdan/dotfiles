type Request = <T = unknown>(path: string, options?: RequestInit) => Promise<T>;

/** Restore granted notifications for the current pairing without another permission prompt. */
export async function activateNotifications(request: Request, active: () => boolean) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const worker = await navigator.serviceWorker.getRegistration();
  if (!worker || !active()) return;
  for (const notification of await worker.getNotifications()) notification.close();
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    !active()
  )
    return;
  let subscription = await worker.pushManager.getSubscription();
  if (!active()) return;
  if (!subscription) {
    const { key } = await request<{ key: string }>("/push/key");
    if (!active()) return;
    const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    });
  }
  if (!active()) return;
  await request("/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
}
