import { Chip, Tooltip } from "@heroui/react";
import { IconStatusDot } from "./icons";
import { describePhone, type PhonePresence } from "../../lib/phonePresence";

const COLORS: Record<PhonePresence, "success" | "warning" | "danger" | "default"> = {
  ONLINE: "success",
  STALE: "warning",
  OFFLINE: "danger",
  NEVER_SEEN: "default",
};

const LABELS: Record<PhonePresence, string> = {
  ONLINE: "Online",
  STALE: "Stale",
  OFFLINE: "Offline",
  NEVER_SEEN: "Never connected",
};

/**
 * §7/§8/§10: the Primary phone is its own status axis.
 *
 * "The browser can reach the GMweb API" is never presented as "the phone is
 * online" — the phone chip can read Offline while the API chip reads
 * Connected, because those are independent facts.
 */
export function PhoneIndicator({
  presence,
  receivedAt,
  model,
}: {
  presence: PhonePresence;
  receivedAt: number | null;
  model?: string | null;
}) {
  const label = LABELS[presence];
  const detail = describePhone(receivedAt);
  return (
    <Tooltip delay={300} closeDelay={80}>
      <Tooltip.Trigger>
        <Chip
          size="sm"
          variant="soft"
          color={COLORS[presence]}
          role="status"
          aria-label={`Primary phone: ${detail}`}
        >
          <IconStatusDot width={7} height={7} aria-hidden />
          <Chip.Label>{label}</Chip.Label>
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {model ? `${model} · ` : ""}
        {detail}
      </Tooltip.Content>
    </Tooltip>
  );
}
