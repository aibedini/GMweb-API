import { Alert, Button, Chip, Drawer, useMediaQuery } from "@heroui/react";
import type { LinkedBrowserSession } from "../../lib/api";
import { formatFullTimestamp, shortId } from "./format";
import { IconLink, IconUnlink } from "./icons";

/**
 * §25: linked browsers in a HeroUI Drawer (right on desktop, bottom on
 * phones). All previously displayed fields are kept and no security behaviour
 * changes — "Unlink this browser" still calls the same sign-out path.
 */
export function LinkedBrowsersDrawer({
  isOpen,
  onOpenChange,
  sessions,
  browserDeviceId,
  signingOut,
  onUnlink,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: LinkedBrowserSession[];
  browserDeviceId: string | null;
  signingOut: boolean;
  onUnlink: () => void;
}) {
  const isMobile = useMediaQuery("(max-width: 767px)", { defaultValue: false });

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement={isMobile ? "bottom" : "right"}>
        <Drawer.Dialog>
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>Linked browsers</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            <div className="mb-3">
              <Alert status="default">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    Sign out removes this browser&apos;s access. To revoke another browser&apos;s trust, open
                    Linked devices on your Primary phone.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            </div>

            {sessions.length === 0 ? (
              <p className="text-sm text-muted">No linked browsers are currently visible.</p>
            ) : (
              sessions.map((session, index) => {
                const isThisBrowser = session.deviceId === browserDeviceId;
                return (
                  <div className="linked-row" key={`${session.deviceId}-${index}`}>
                    <div className="linked-row__head">
                      <Chip size="sm" variant="soft" color={session.onlineNow ? "success" : "default"}>
                        <Chip.Label>{session.onlineNow ? "Online" : "Inactive"}</Chip.Label>
                      </Chip>
                      {isThisBrowser ? (
                        <Chip size="sm" variant="soft" color="accent">
                          <Chip.Label>This browser</Chip.Label>
                        </Chip>
                      ) : null}
                      <span className="font-mono text-xs text-muted" title={session.deviceId}>
                        {shortId(session.deviceId)}
                      </span>
                    </div>

                    <dl className="linked-row__meta">
                      <dt>IP</dt>
                      <dd>{session.ip || "IP unavailable"}</dd>
                      <dt>Browser</dt>
                      <dd>{session.userAgent || "Browser unknown"}</dd>
                      <dt>Last seen</dt>
                      <dd>{formatFullTimestamp(session.lastSeenAt)}</dd>
                      <dt>Last data request</dt>
                      <dd>
                        {session.lastDataAt
                          ? formatFullTimestamp(session.lastDataAt)
                          : "No data request observed"}
                      </dd>
                      <dt>Last durable sync</dt>
                      <dd>
                        {session.lastSyncAt
                          ? formatFullTimestamp(session.lastSyncAt)
                          : "No sync acknowledgement"}
                      </dd>
                    </dl>

                    {isThisBrowser ? (
                      <div>
                        <Button
                          size="sm"
                          variant="danger-soft"
                          isDisabled={signingOut}
                          onPress={onUnlink}
                          aria-label="Unlink this browser"
                        >
                          <IconUnlink width={15} height={15} aria-hidden />
                          <span>{signingOut ? "Unlinking…" : "Unlink this browser"}</span>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}

            {browserDeviceId ? (
              <p className="mt-4 flex items-center gap-2 text-xs text-muted">
                <IconLink width={14} height={14} aria-hidden />
                This browser: <span className="font-mono">{shortId(browserDeviceId)}</span>
              </p>
            ) : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
