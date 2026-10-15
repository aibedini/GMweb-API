import { Alert, Card, Chip } from "@heroui/react";
import type { TrustSnapshot } from "../../lib/api";
import { IconBell, IconKey, IconLock, IconVerified } from "../components/icons";

/**
 * §29: Security as an operational tool surface — Cards, Chips and Alerts, with
 * no change to what is actually reported and no exposure of key material.
 */
export function SecurityView({
  decrypted,
  locked,
  invalid,
  trust,
  keyState,
  keyError,
  browserIdentity,
  verifiedPrimary,
}: {
  decrypted: number;
  locked: number;
  invalid: number;
  trust: TrustSnapshot | null;
  keyState: string;
  keyError: string | null;
  /** `null` until diagnostics have been collected for this session. */
  browserIdentity: boolean | null;
  verifiedPrimary: boolean | null;
}) {
  const keyColor = keyState === "FAILED" ? "danger" : keyState === "UP_TO_DATE" ? "success" : "warning";
  const identityKnown = browserIdentity !== null && verifiedPrimary !== null;
  const identityOk = browserIdentity === true && verifiedPrimary === true;

  return (
    <div className="view-scroll scroll-region">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-head__copy">
            <p className="view-eyebrow">Protection</p>
            <h1 className="view-title">Security</h1>
            <p className="view-subtitle">
              Credentials and identities visible to this linked browser. Private keys and tokens are never
              displayed here.
            </p>
          </div>
        </div>

        {keyError ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Key maintenance reported a problem</Alert.Title>
              <Alert.Description>{keyError}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {invalid > 0 ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Some payloads failed authentication</Alert.Title>
              <Alert.Description>
                {invalid} encrypted payload(s) in the open thread could not be authenticated. They are
                reported as corrupt rather than silently dropped.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="view-section">
          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Message encryption</strong>
                <span>
                  {decrypted} decrypted · {locked} locked · {invalid} invalid in the currently open thread.
                  Messages load when a conversation is opened; key grants come from your Primary phone.
                </span>
              </div>
              <Chip size="sm" variant="soft" color={invalid ? "danger" : locked ? "warning" : "success"}>
                <Chip.Label>{invalid ? "Attention" : locked ? "Partly locked" : "Healthy"}</Chip.Label>
              </Chip>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Encryption keys</strong>
                <span>
                  Key state is {keyState.toLowerCase()}. Grants are fetched from the replica; missing keys
                  keep messages locked until the phone publishes a grant.
                </span>
              </div>
              <Chip size="sm" variant="soft" color={keyColor}>
                <Chip.Label>{keyState}</Chip.Label>
              </Chip>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Android trust registry</strong>
                <span>
                  {trust
                    ? `Verified root published at sequence ${trust.trustSequence}.`
                    : "Waiting for the Primary phone's first signed trust statement."}
                </span>
              </div>
              <Chip size="sm" variant="soft" color={trust ? "success" : "warning"}>
                <Chip.Label>{trust ? "Ready" : "Pending"}</Chip.Label>
              </Chip>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>This browser&apos;s identity</strong>
                <span>
                  {!identityKnown
                    ? "Run diagnostics to check the browser identity and the Primary phone's trust root."
                    : `${browserIdentity ? "A device-bound browser key pair exists in this browser." : "No browser identity was found — re-link this browser."} ${
                        verifiedPrimary
                          ? "The Primary phone's trust root has been verified."
                          : "The Primary phone's trust root has not been verified yet."
                      }`}
                </span>
              </div>
              <Chip size="sm" variant="soft" color={!identityKnown ? "default" : identityOk ? "success" : "warning"}>
                <Chip.Label>{!identityKnown ? "Unknown" : identityOk ? "Verified" : "Incomplete"}</Chip.Label>
              </Chip>
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Passkeys</strong>
                <span>Manage dashboard passkeys in the GMweb dashboard, not from this PWA.</span>
              </div>
              <IconKey width={16} height={16} aria-hidden />
            </Card.Content>
          </Card>

          <Card>
            <Card.Content className="settings-row">
              <div className="settings-row__copy">
                <strong>Private push</strong>
                <span>Notifications contain no sender or message text.</span>
              </div>
              <IconBell width={16} height={16} aria-hidden />
            </Card.Content>
          </Card>
        </div>

        <p className="flex items-center gap-2 text-xs text-muted">
          <IconLock width={13} height={13} aria-hidden />
          <IconVerified width={13} height={13} aria-hidden />
          Verification status is reported from the stored trust snapshot only.
        </p>
      </div>
    </div>
  );
}
