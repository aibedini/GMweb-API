import { Button, Card, Chip } from "@heroui/react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { IconDiagnostics, IconLinked, IconSignOut } from "../components/icons";

/**
 * §5/§47: Settings holds appearance, linked devices, version/build info and
 * sign out. The API version lives here rather than in the top bar, and
 * Diagnostics is reachable from here on the compact breakpoints where the
 * bottom navigation has no slot for it.
 */
export function SettingsView({
  apiVersion,
  pwaVersion,
  scriptFile,
  buildRevision,
  linkedOnlineCount,
  linkedTotal,
  onOpenLinkedBrowsers,
  onOpenDiagnostics,
  onSignOut,
  signingOut,
}: {
  apiVersion: string;
  pwaVersion: string;
  scriptFile: string;
  buildRevision: string | null;
  linkedOnlineCount: number;
  linkedTotal: number;
  onOpenLinkedBrowsers: () => void;
  onOpenDiagnostics: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <div className="view-scroll scroll-region">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-head__copy">
            <p className="view-eyebrow">Preferences</p>
            <h1 className="view-title">Settings</h1>
            <p className="view-subtitle">
              Appearance, linked devices and the exact build this browser is running.
            </p>
          </div>
        </div>

        <section className="view-section">
          <h2 className="view-section__title">Appearance</h2>
          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Theme</strong>
                <span>
                  Dark is the default product look. Choose Light, Dark, or System to follow your device.
                </span>
              </div>
              <ThemeSwitcher />
            </Card.Content>
          </Card>
        </section>

        <section className="view-section">
          <h2 className="view-section__title">Devices</h2>
          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Linked browsers</strong>
                <span>
                  {linkedTotal === 0
                    ? "No linked browsers are currently visible."
                    : `${linkedOnlineCount} of ${linkedTotal} linked browser(s) online now.`}
                </span>
              </div>
              <Button variant="secondary" size="sm" onPress={onOpenLinkedBrowsers}>
                <IconLinked width={15} height={15} aria-hidden />
                <span>Review sessions</span>
              </Button>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Diagnostics</strong>
                <span>Inspect sync, crypto, storage and projection state of this browser.</span>
              </div>
              <Button variant="secondary" size="sm" onPress={onOpenDiagnostics}>
                <IconDiagnostics width={15} height={15} aria-hidden />
                <span>Open diagnostics</span>
              </Button>
            </Card.Content>
          </Card>
        </section>

        <section className="view-section">
          <h2 className="view-section__title">About</h2>
          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Build</strong>
                <span>
                  GMweb API {apiVersion} · PWA {pwaVersion} · bundle {scriptFile}
                  {buildRevision ? ` · revision ${buildRevision.slice(0, 12)}` : ""}
                </span>
              </div>
              <Chip size="sm" variant="soft" color="default">
                <Chip.Label>v{pwaVersion}</Chip.Label>
              </Chip>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Sign out</strong>
                <span>Unlink this browser. Local replicated data and keys are removed from this device.</span>
              </div>
              <Button
                variant="danger-soft"
                size="sm"
                onPress={onSignOut}
                isDisabled={signingOut}
                aria-label="Sign out of this browser"
              >
                <IconSignOut width={15} height={15} aria-hidden />
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
              </Button>
            </Card.Content>
          </Card>
        </section>
      </div>
    </div>
  );
}
