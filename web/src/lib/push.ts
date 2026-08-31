/**
 * web-01 (§4/§45) — Push subscription plumbing for the PWA.
 * Permission prompt only happens behind an explicit user click (the
 * "Enable push" control in the Debug tab) — never on page load.
 */

const SW_PATH = "/web/sw.js";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_PATH, { scope: "/web/" });
  } catch {
    return null;
  }
}

async function ensurePermission(): Promise<NotificationPermission> {
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

/** Full subscribe flow: SW ready → permission → pushManager.subscribe. */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<PushSubscription | null> {
  const permission = await ensurePermission();
  if (permission !== "granted") return null;
  const registration = await registerServiceWorker();
  if (!registration) return null;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  // applicationServerKey: base64url → Uint8Array (browser requirement)
  const keyBytes = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  return registration.pushManager.subscribe({
    userVisibleOnly: true, // §5 iOS contract — every push is visible
    applicationServerKey: keyBytes.buffer as ArrayBuffer,
  });
}

export async function unsubscribeFromPush(): Promise<boolean> {
  const registration = await navigator.serviceWorker?.getRegistration("/web/");
  const sub = await registration?.pushManager.getSubscription();
  if (!sub) return false;
  return sub.unsubscribe();
}

/** POST the browser subscription to the control plane (§89 binding). */
export async function sendSubscriptionToServer(sub: PushSubscription): Promise<boolean> {
  const raw = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) return false;
  const res = await fetch("/api/v1/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: raw.endpoint, keys: raw.keys }),
  });
  return res.ok;
}

export async function removeSubscriptionFromServer(endpoint: string): Promise<boolean> {
  const res = await fetch("/api/v1/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  return res.ok;
}
