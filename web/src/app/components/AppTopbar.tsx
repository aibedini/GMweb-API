import type { ReactNode } from "react";
import { Button, Dropdown, Tooltip } from "@heroui/react";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";
import type { PhonePresence } from "../../lib/phonePresence";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { PhoneIndicator } from "./PhoneIndicator";
import { RealtimeIndicator } from "./RealtimeIndicator";
import { SyncIndicator } from "./SyncIndicator";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { IconLinked, IconPerson, IconSettings, IconSignOut } from "./icons";
import type { ConnectionState } from "./types";

/**
 * §11: a compact 56px top bar.
 *
 * Right side: API / Realtime / Phone chips (three INDEPENDENT axes), sync
 * action, theme, linked browsers and the account/app menu. The API version
 * deliberately does NOT live here — it is surfaced in Settings/About and in
 * Diagnostics (§11).
 */
export function AppTopbar({
  title,
  subtitle,
  connection,
  connectionDetail,
  phonePresence,
  phoneReceivedAt,
  phoneModel,
  syncStatus,
  syncBusy,
  onSync,
  linkedOnlineCount,
  onOpenLinkedBrowsers,
  onOpenSettings,
  onSignOut,
  signingOut,
  leading,
}: {
  title: string;
  subtitle?: string;
  connection: ConnectionState;
  connectionDetail?: string;
  phonePresence: PhonePresence;
  phoneReceivedAt: number | null;
  phoneModel?: string | null;
  syncStatus: BrowserSyncStatus;
  syncBusy: boolean;
  onSync: () => void;
  linkedOnlineCount: number;
  onOpenLinkedBrowsers: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  signingOut: boolean;
  leading?: ReactNode;
}) {
  const linkedLabel =
    linkedOnlineCount === 1 ? "1 linked browser online" : `${linkedOnlineCount} linked browsers online`;

  return (
    <header className="app-topbar">
      {leading}
      <div className="app-topbar__title">
        <strong>{title}</strong>
        {subtitle ? <span className="bidi-text">{subtitle}</span> : null}
      </div>

      <div className="app-topbar__actions">
        <ConnectionIndicator state={connection} detail={connectionDetail} />

        <RealtimeIndicator />

        <PhoneIndicator presence={phonePresence} receivedAt={phoneReceivedAt} model={phoneModel} />

        <SyncIndicator status={syncStatus} busy={syncBusy} onSync={onSync} compact />

        <Tooltip delay={350} closeDelay={80}>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              isIconOnly
              aria-label={linkedLabel}
              onPress={onOpenLinkedBrowsers}
            >
              <IconLinked width={17} height={17} aria-hidden />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{linkedLabel} — review sessions</Tooltip.Content>
        </Tooltip>

        <ThemeSwitcher />

        <Dropdown>
          <Dropdown.Trigger className="account-trigger" aria-label="Account and app menu">
            <IconPerson width={17} height={17} aria-hidden />
          </Dropdown.Trigger>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label="Account and app menu"
              onAction={(key) => {
                if (key === "settings") onOpenSettings();
                if (key === "browsers") onOpenLinkedBrowsers();
                if (key === "signout") onSignOut();
              }}
            >
              <Dropdown.Item id="settings" textValue="Settings">
                <IconSettings width={15} height={15} aria-hidden />
                <span>Settings</span>
              </Dropdown.Item>
              <Dropdown.Item id="browsers" textValue="Linked browsers">
                <IconLinked width={15} height={15} aria-hidden />
                <span>Linked browsers</span>
              </Dropdown.Item>
              <Dropdown.Item
                id="signout"
                textValue="Sign out"
                variant="danger"
                isDisabled={signingOut}
              >
                <IconSignOut width={15} height={15} aria-hidden />
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </header>
  );
}
