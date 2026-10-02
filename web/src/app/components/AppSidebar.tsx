import { Button, Tooltip } from "@heroui/react";
import { RAIL_DESTINATIONS, SETTINGS_DESTINATION, type DestinationMeta } from "./destinations";
import type { DestinationKey } from "./types";

function RailItem({
  destination,
  active,
  unreadTotal,
  onNavigate,
}: {
  destination: DestinationMeta;
  active: boolean;
  unreadTotal: number;
  onNavigate: (key: DestinationKey) => void;
}) {
  const { key, label, Icon } = destination;
  return (
    <Tooltip delay={350} closeDelay={80}>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          className="app-rail__item"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          onPress={() => onNavigate(key)}
        >
          <Icon width={19} height={19} aria-hidden />
          {key === "inbox" && unreadTotal > 0 ? (
            <span className="app-rail__badge" aria-hidden>
              {unreadTotal > 99 ? "99+" : unreadTotal}
            </span>
          ) : null}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {label}
        {key === "inbox" && unreadTotal > 0 ? ` · ${unreadTotal} unread` : ""}
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * §12: desktop navigation rail — 72px collapsed, icons with tooltips, active
 * item marked by a soft accent background plus an inline-start accent bar.
 */
export function AppSidebar({
  active,
  unreadTotal,
  onNavigate,
}: {
  active: DestinationKey;
  unreadTotal: number;
  onNavigate: (key: DestinationKey) => void;
}) {
  return (
    <nav className="app-rail" aria-label="Primary">
      <div className="app-rail__brand" aria-hidden="true">
        M
      </div>

      <div className="app-rail__nav">
        {RAIL_DESTINATIONS.map((destination) => (
          <RailItem
            key={destination.key}
            destination={destination}
            active={active === destination.key}
            unreadTotal={unreadTotal}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <div className="app-rail__spacer" />

      <div className="app-rail__footer">
        <RailItem
          destination={SETTINGS_DESTINATION}
          active={active === "settings"}
          unreadTotal={0}
          onNavigate={onNavigate}
        />
      </div>
    </nav>
  );
}
