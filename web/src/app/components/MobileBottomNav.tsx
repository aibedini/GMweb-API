import { MOBILE_DESTINATIONS } from "./destinations";
import type { DestinationKey } from "./types";

/**
 * §40: bottom navigation for every breakpoint below the desktop rail
 * (touch-first tablet and phone). Every target is at least 44px tall.
 */
export function MobileBottomNav({
  active,
  unreadTotal,
  onNavigate,
}: {
  active: DestinationKey;
  unreadTotal: number;
  onNavigate: (key: DestinationKey) => void;
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {MOBILE_DESTINATIONS.map(({ key, label, Icon }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            className="mobile-nav__item"
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(key)}
          >
            <Icon width={19} height={19} aria-hidden />
            <span>{label}</span>
            {key === "inbox" && unreadTotal > 0 ? (
              <span className="mobile-nav__badge" aria-hidden>
                {unreadTotal > 99 ? "99+" : unreadTotal}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
