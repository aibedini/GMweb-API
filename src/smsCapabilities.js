"use strict";

function smsCapabilities(telemetry, now = Date.now()) {
  const subscriptions = telemetry?.smsSubscriptions;
  const stale = !telemetry || now - telemetry.receivedAt > 180_000;
  const items = Array.isArray(subscriptions?.items) ? subscriptions.items
    .filter(item => Number.isSafeInteger(item.subscriptionId) && item.subscriptionId >= 0)
    .map(item => ({ subscriptionId: item.subscriptionId, slotIndex: item.slotIndex,
      carrierName: item.carrierName || "", displayName: item.displayName || "",
      isActive: item.isActive === true, isDefaultSms: item.isDefaultSms === true,
      sendCapable: typeof item.sendCapable === "boolean" ? item.sendCapable : null })) : [];
  return { available: !stale && subscriptions?.available === true, stale,
    receivedAt: telemetry?.receivedAt ?? null, items,
    sendSmsPermission: typeof subscriptions?.sendSmsPermission === "boolean" ? subscriptions.sendSmsPermission : null,
    isDefaultSmsApp: typeof subscriptions?.isDefaultSmsApp === "boolean" ? subscriptions.isDefaultSmsApp : null };
}
module.exports = { smsCapabilities };
