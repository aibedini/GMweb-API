import { Chip } from "@heroui/react";
import { IconStatusDot } from "./icons";
import type { ConnectionState } from "./types";

const LABELS: Record<ConnectionState, string> = {
  checking: "Checking",
  connected: "Connected",
  offline: "Offline",
  unreachable: "Needs attention",
};

const COLORS = {
  checking: "default",
  connected: "success",
  offline: "danger",
  unreachable: "warning",
} as const;

/**
 * §11/§45: connection state as a single HeroUI Chip — no raw green dot span
 * plus sibling label. `role="status"` keeps the change non-interruptive.
 */
export function ConnectionIndicator({ state, detail }: { state: ConnectionState; detail?: string }) {
  const label = LABELS[state];
  return (
    <Chip
      size="sm"
      variant="soft"
      color={COLORS[state]}
      role="status"
      title={detail}
      aria-label={`Connection: ${label}`}
    >
      <IconStatusDot width={7} height={7} aria-hidden />
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}
