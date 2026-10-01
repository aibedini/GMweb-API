export function androidError(reason: string): string {
  let value: unknown;
  try { value = JSON.parse(reason); } catch { value = reason; }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const detail = record && [record.error, record.reason, record.code, record.message].find(item => typeof item === "string");
  const text = typeof value === "string" ? value : typeof detail === "string" ? detail : reason;
  const code = text.toLowerCase();
  if (/selected_sim_unavailable|subscription_unavailable|invalid_subscription|sim_unavailable/.test(code)) return "Selected SIM unavailable";
  if (/send_sms_permission|missing_send_sms|permission_denied/.test(code)) return "SEND_SMS permission missing";
  if (/not_default_sms|default_sms_app_required/.test(code)) return "Phone is not default SMS app";
  if (/carrier_rejected/.test(code)) return "Carrier rejected message";
  return text;
}
export interface SendStatus {
  requestId?: string; clientMessageId?: string; status: string; stage?: string;
  failedReason?: string; carrierStatus?: { status: string };
  submittedOnce?: boolean;
}
export function sendStatusLabel(state: SendStatus): string {
  if (state.carrierStatus?.status === "delivered") return "Delivered";
  if (state.carrierStatus?.status === "failed") return "Failed · Carrier rejected message";
  if (state.status === "failed") return `Failed · ${androidError(state.failedReason || "Phone did not report a reason")}`;
  if (state.status === "sent" || state.status === "completed") return state.submittedOnce === false ? "Submission unverified" : "Sent";
  if (state.status === "unverified") return "Submission unverified";
  if (["cancelled", "superseded", "suppressed"].includes(state.status)) return state.status;
  if (state.stage === "phone_pulled") return "Pulled by phone";
  if (["phone_sending", "phone_submitting"].includes(state.stage || "")) return "Submitting";
  return "Queued";
}
