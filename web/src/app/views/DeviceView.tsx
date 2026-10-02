import { Alert, Card, Chip } from "@heroui/react";
import type { DeviceTelemetry, TrustSnapshot } from "../../lib/api";
import type { BrowserSyncStatus } from "../../lib/sync/sync-state";
import { syncLabel } from "../components/SyncIndicator";
import { formatListTime } from "../components/format";
import { IconDevice, IconKey, IconStorage, IconSync } from "../components/icons";

function StatusCard({
  label,
  value,
  detail,
  color = "default",
  statusText,
}: {
  label: string;
  value: string;
  detail?: string;
  color?: "default" | "success" | "warning" | "danger" | "accent";
  statusText?: string;
}) {
  return (
    <Card>
      <Card.Content className="status-card">
        <span className="status-card__label">{label}</span>
        <span className="status-card__value">{value}</span>
        {statusText ? (
          <Chip size="sm" variant="soft" color={color}>
            <Chip.Label>{statusText}</Chip.Label>
          </Chip>
        ) : null}
        {detail ? <span className="status-card__detail">{detail}</span> : null}
      </Card.Content>
    </Card>
  );
}

/**
 * §27: Device / connection screen, grouped into DEVICE, SYNC, SECURITY and APP.
 *
 * Giant numbers are avoided unless the metric is genuinely meaningful, and
 * every status uses HeroUI's semantic colours.
 */
export function DeviceView({
  apiVersion,
  pwaVersion,
  scriptFile,
  cursor,
  appliedEvents,
  latestSequence,
  trust,
  telemetry,
  syncStatus,
  bootstrapState,
  error,
  payloadState,
}: {
  apiVersion: string;
  pwaVersion: string;
  scriptFile: string;
  cursor: number;
  appliedEvents: number | null;
  latestSequence: number;
  trust: TrustSnapshot | null;
  telemetry: DeviceTelemetry | null;
  syncStatus: BrowserSyncStatus;
  bootstrapState: string | null;
  error: string | null;
  payloadState: string;
}) {
  const apiOffline = apiVersion === "unreachable";
  const battery = telemetry?.battery;
  const network = telemetry?.network;
  const keyFailed = syncStatus.keyState === "FAILED";

  return (
    <div className="view-scroll scroll-region">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-head__copy">
            <p className="view-eyebrow">System</p>
            <h1 className="view-title">Device</h1>
            <p className="view-subtitle">
              Live state of this PWA, the Android sync pipeline and the trust registry.
            </p>
          </div>
          <Chip size="sm" variant="soft" color={apiOffline ? "danger" : "success"}>
            <Chip.Label>{apiOffline ? "API unreachable" : "API healthy"}</Chip.Label>
          </Chip>
        </div>

        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Something went wrong</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {keyFailed ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Encryption keys need attention</Alert.Title>
              <Alert.Description>
                {syncStatus.keyError || "Key maintenance failed. Some messages may stay locked."}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <section className="view-section">
          <h2 className="view-section__title">
            <IconDevice width={13} height={13} aria-hidden />
            Device
          </h2>
          <div className="status-grid">
            <StatusCard
              label="Phone"
              value={telemetry?.device?.model || "—"}
              detail={
                telemetry?.device
                  ? `${telemetry.device.manufacturer ?? ""} · Android ${telemetry.device.androidVersion ?? "unknown"}`
                  : "Waiting for the Primary phone to report telemetry"
              }
              color={telemetry?.device ? "success" : "default"}
              statusText={telemetry?.device ? "Reported" : "Pending"}
            />
            <StatusCard
              label="Battery"
              value={battery?.level == null ? "—" : `${battery.level}%`}
              detail={battery?.isCharging ? `Charging${battery.chargingSource ? ` · ${battery.chargingSource}` : ""}` : "Not charging"}
              color={battery?.level == null ? "default" : battery.level < 20 && !battery.isCharging ? "danger" : "success"}
              statusText={battery?.isCharging ? "charging" : undefined}
            />
            <StatusCard
              label="Network"
              value={network ? (network.isConnected ? "Connected" : "Offline") : "—"}
              detail={network?.networkType || "Waiting for telemetry"}
              color={network ? (network.isConnected ? "success" : "danger") : "default"}
            />
            <StatusCard
              label="Android app"
              value={telemetry?.app?.versionName || "—"}
              detail={
                telemetry?.receivedAt
                  ? `Last report ${formatListTime(telemetry.receivedAt)}`
                  : "Never reported"
              }
              color={telemetry ? "success" : "default"}
              statusText={telemetry ? undefined : "Waiting"}
            />
          </div>
        </section>

        <section className="view-section">
          <h2 className="view-section__title">
            <IconSync width={13} height={13} aria-hidden />
            Sync
          </h2>
          <div className="status-grid">
            <StatusCard
              label="Browser sync"
              value={syncLabel(syncStatus.state)}
              detail={
                syncStatus.lastSuccessfulSyncAt
                  ? `Last success ${formatListTime(syncStatus.lastSuccessfulSyncAt)}`
                  : "No successful sync yet in this browser"
              }
              color={
                syncStatus.state === "UP_TO_DATE"
                  ? "success"
                  : syncStatus.state === "FAILED"
                    ? "danger"
                    : syncStatus.state === "DEGRADED"
                      ? "warning"
                      : "default"
              }
              statusText={syncStatus.state.replaceAll("_", " ").toLowerCase()}
            />
            <StatusCard
              label="Sync cursor"
              value={String(cursor)}
              detail={appliedEvents === null ? "Ready" : `${appliedEvents} event(s) applied in this run`}
            />
            <StatusCard
              label="Stored events"
              value={String(latestSequence)}
              detail={`Latest stored sequence${bootstrapState ? ` · session ${bootstrapState}` : ""}`}
            />
            <StatusCard
              label="Android outbox"
              value={telemetry?.sync?.outboxDepth == null ? "—" : String(telemetry.sync.outboxDepth)}
              detail={
                telemetry?.sync?.deadLetterCount
                  ? `${telemetry.sync.deadLetterCount} dead letter(s)`
                  : "No dead letters reported"
              }
              color={telemetry?.sync?.deadLetterCount ? "warning" : "default"}
            />
          </div>
        </section>

        <section className="view-section">
          <h2 className="view-section__title">
            <IconKey width={13} height={13} aria-hidden />
            Security
          </h2>
          <div className="status-grid">
            <StatusCard
              label="Payload protection"
              value={payloadState}
              detail="Encrypted messages need a key grant from your Primary phone. Missing keys stay locked; failed authentication is reported as corrupt."
            />
            <StatusCard
              label="Trust registry"
              value={trust ? String(trust.trustSequence) : "—"}
              detail={
                trust
                  ? "Android-signed trust statement available"
                  : "Waiting for the first Android trust statement"
              }
              color={trust ? "success" : "warning"}
              statusText={trust ? "Ready" : "Pending"}
            />
            <StatusCard
              label="Encryption keys"
              value={syncStatus.keyState}
              detail={
                syncStatus.keyError ||
                (syncStatus.lastKeySyncAt
                  ? `Last successful refresh ${formatListTime(syncStatus.lastKeySyncAt)}`
                  : "No key refresh yet")
              }
              color={
                syncStatus.keyState === "FAILED"
                  ? "danger"
                  : syncStatus.keyState === "UP_TO_DATE"
                    ? "success"
                    : "default"
              }
            />
            <StatusCard
              label="Linked session"
              value="Authenticated"
              detail="This browser holds a device-bound linked session."
              color="success"
              statusText="linked"
            />
          </div>
        </section>

        <section className="view-section">
          <h2 className="view-section__title">
            <IconStorage width={13} height={13} aria-hidden />
            App
          </h2>
          <div className="status-grid">
            <StatusCard
              label="GMweb API version"
              value={apiVersion}
              detail={apiOffline ? "The API could not be reached from this browser" : "Reported by GET /health"}
              color={apiOffline ? "danger" : "success"}
            />
            <StatusCard
              label="PWA build"
              value={pwaVersion}
              detail={`Loaded bundle ${scriptFile}`}
            />
            <StatusCard
              label="Telemetry age"
              value={
                telemetry?.receivedAt
                  ? `${Math.max(0, Math.round((Date.now() - telemetry.receivedAt) / 1000))}s`
                  : "—"
              }
              detail="Android reports telemetry roughly once a minute"
            />
            <StatusCard
              label="SIM telemetry"
              value={
                telemetry?.smsSubscriptions
                  ? `${telemetry.smsSubscriptions.items.filter((sim) => sim.isActive).length} active`
                  : "—"
              }
              detail={
                telemetry?.smsSubscriptions
                  ? telemetry.smsSubscriptions.available
                    ? "Phone permission granted"
                    : "Phone permission not granted"
                  : "Phone has not reported its SIMs"
              }
              color={telemetry?.smsSubscriptions?.available ? "success" : "warning"}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
