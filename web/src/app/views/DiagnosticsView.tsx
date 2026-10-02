import { Accordion, Alert, Button, Card, Chip, Spinner, Tabs, toast } from "@heroui/react";
import type { WebDiagnosticReport } from "../../lib/diagnostics";
import { formatWebDiagnostics } from "../../lib/diagnostics";
import { formatListTime, pluralize } from "../components/format";
import { IconChevronDown, IconCopy, IconReport, IconRetry } from "../components/icons";

function outcomeColor(value: string): "default" | "success" | "warning" | "danger" | "accent" {
  if (value === "PASS") return "success";
  if (value === "WARN") return "warning";
  if (value === "FAIL") return "danger";
  if (value === "SYNCING") return "accent";
  return "default";
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <Card>
      <Card.Content className="status-card">
        <span className="status-card__label">{label}</span>
        <span className="status-card__value">
          <Chip size="sm" variant="soft" color={outcomeColor(value)}>
            <Chip.Label>{value}</Chip.Label>
          </Chip>
        </span>
        {detail ? <span className="status-card__detail">{detail}</span> : null}
      </Card.Content>
    </Card>
  );
}

/**
 * §29: Diagnostics as a copyable operational surface — Tabs for summary vs raw
 * report, Accordion for the per-engine breakdown, and a single "Copy
 * diagnostics" action that uses the already-safe `formatWebDiagnostics`
 * output (no keys, secrets or auth tokens).
 */
export function DiagnosticsView({
  report,
  busy,
  syncBusy,
  onRun,
  onRetrySync,
}: {
  report: WebDiagnosticReport | null;
  busy: boolean;
  syncBusy: boolean;
  onRun: () => void;
  onRetrySync: () => void;
}) {
  const copy = () => {
    if (!report) return;
    void navigator.clipboard
      .writeText(formatWebDiagnostics(report))
      .then(() => toast.success("Diagnostic report copied"))
      .catch(() => toast.danger("Could not copy the diagnostic report"));
  };

  return (
    <div className="view-scroll scroll-region">
      <div className="view-inner">
        <div className="view-head">
          <div className="view-head__copy">
            <p className="view-eyebrow">Diagnostics</p>
            <h1 className="view-title">Web message diagnostics</h1>
            <p className="view-subtitle">
              Privacy-safe counts across server, browser storage, crypto and projection. Collected on demand
              in this browser only.
            </p>
          </div>
          <div className="diagnostics-toolbar">
            <Button variant="secondary" onPress={onRun} isDisabled={busy}>
              {busy ? <Spinner size="sm" /> : <IconReport width={15} height={15} aria-hidden />}
              <span>{busy ? "Collecting…" : report ? "Re-run diagnostics" : "Run diagnostics"}</span>
            </Button>
            <Button variant="ghost" onPress={copy} isDisabled={!report}>
              <IconCopy width={15} height={15} aria-hidden />
              <span>Copy diagnostics</span>
            </Button>
            <Button variant="ghost" onPress={onRetrySync} isDisabled={syncBusy}>
              <IconRetry width={15} height={15} aria-hidden />
              <span>Retry sync</span>
            </Button>
          </div>
        </div>

        {!report ? (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>No report collected yet</Alert.Title>
              <Alert.Description>
                Run diagnostics to snapshot the sync, crypto, storage and projection state of this browser.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <>
            <Alert status={report.overall === "FAIL" ? "danger" : report.overall === "WARN" ? "warning" : "success"}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Overall: {report.overall}</Alert.Title>
                <Alert.Description>
                  Collected {formatListTime(report.collectedAt)} · API {report.session.apiVersion} · PWA{" "}
                  {report.session.pwaVersion} · bundle {report.session.loadedScript}
                </Alert.Description>
              </Alert.Content>
            </Alert>

            <Tabs defaultSelectedKey="summary" variant="secondary">
              <Tabs.ListContainer>
                <Tabs.List aria-label="Diagnostics view">
                  <Tabs.Tab id="summary">
                    Summary
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="report">
                    Report
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>

              <Tabs.Panel id="summary" className="pt-4">
                <div className="view-section">
                  <div className="status-grid">
                    <Metric
                      label="Server"
                      value={report.session.linked && report.server ? "PASS" : "FAIL"}
                      detail={`${report.server?.total ?? "Unavailable"} events · max sequence ${report.server?.maxSequence ?? "—"}`}
                    />
                    <Metric
                      label="Browser sync"
                      value={
                        report.browserSync.state === "UP_TO_DATE"
                          ? "PASS"
                          : report.browserSync.state === "FAILED"
                            ? "FAIL"
                            : report.browserSync.state === "DEGRADED"
                              ? "WARN"
                              : "SYNCING"
                      }
                      detail={`cursor ${report.browserSync.cursor} · lag ${report.browserSync.syncLag ?? "unknown"}`}
                    />
                    <Metric
                      label="Encryption keys"
                      value={report.browserSync.keyState}
                      detail={
                        report.browserSync.keyError ||
                        (report.browserSync.lastKeySyncAt
                          ? `Last successful refresh ${formatListTime(report.browserSync.lastKeySyncAt)}`
                          : "No key refresh yet")
                      }
                    />
                    <Metric
                      label="Live updates"
                      value={report.liveSync.connection}
                      detail={`${report.liveSync.reconnectCount} reconnects · last frame ${
                        report.liveSync.lastFrameAt ? formatListTime(report.liveSync.lastFrameAt) : "none"
                      }`}
                    />
                    <Metric
                      label="IndexedDB"
                      value="PASS"
                      detail={`${report.indexedDb.total} raw events · ${report.indexedDb.distinctMessageAggregateCount} message aggregates`}
                    />
                    <Metric
                      label="Crypto"
                      value={report.crypto.messages.invalid ? "FAIL" : report.crypto.messages.locked ? "WARN" : "PASS"}
                      detail={`${report.crypto.messages.decrypted} decrypted · ${report.crypto.messages.locked} locked · ${report.crypto.messages.invalid} invalid`}
                    />
                    <Metric
                      label="Projection"
                      value={report.projection.failure ? "FAIL" : report.projection.lag ? "SYNCING" : "PASS"}
                      detail={report.projection.failure || `${pluralize(report.projection.rows, "row")} · cursor ${report.projection.cursor}`}
                    />
                    <Metric
                      label="Contacts"
                      value={report.contacts.failure ? "WARN" : "PASS"}
                      detail={report.contacts.failure || `${report.contacts.stored} rows · ${report.contacts.grants} grants`}
                    />
                    <Metric
                      label="Selected thread"
                      value={
                        !report.selectedThread
                          ? "PASS"
                          : report.selectedThread.state === "FAILED"
                            ? "FAIL"
                            : report.selectedThread.state === "LOADING"
                              ? "SYNCING"
                              : report.selectedThread.state === "LOCKED"
                                ? "WARN"
                                : "PASS"
                      }
                      detail={
                        report.selectedThread
                          ? `${report.selectedThread.state} · ${report.selectedThread.decrypted} decrypted · ${report.selectedThread.locked} locked`
                          : "No conversation selected"
                      }
                    />
                    <Metric
                      label="Build / service worker"
                      value={report.session.buildMismatch ? "FAIL" : "PASS"}
                      detail={`loaded ${report.session.loadedScript} · served ${report.session.servedScript ?? "unknown"} · revision ${report.session.buildRevision ?? "unknown"} · ${report.session.serviceWorker}`}
                    />
                  </div>
                </div>

                <div className="view-section mt-4">
                  <Accordion>
                    <Accordion.Item>
                      <Accordion.Heading>
                        <Accordion.Trigger>
                          Sync engine detail
                          <Accordion.Indicator>
                            <IconChevronDown />
                          </Accordion.Indicator>
                        </Accordion.Trigger>
                      </Accordion.Heading>
                      <Accordion.Panel>
                        <Accordion.Body>
                          Cursor {report.browserSync.cursor} · projection cursor{" "}
                          {report.browserSync.projectionCursor} · snapshot{" "}
                          {report.replicaProgress?.snapshotComplete ? "complete" : "loading"} · keyring{" "}
                          {report.replicaProgress?.keyringCursor ?? "unknown"} · grants{" "}
                          {report.replicaProgress?.grantCursor ?? "unknown"}
                        </Accordion.Body>
                      </Accordion.Panel>
                    </Accordion.Item>
                    <Accordion.Item>
                      <Accordion.Heading>
                        <Accordion.Trigger>
                          Crypto detail
                          <Accordion.Indicator>
                            <IconChevronDown />
                          </Accordion.Indicator>
                        </Accordion.Trigger>
                      </Accordion.Heading>
                      <Accordion.Panel>
                        <Accordion.Body>
                          Browser identity {report.crypto.browserIdentity ? "present" : "missing"} · primary
                          verified {report.crypto.verifiedPrimary ? "yes" : "no"} · grant probe{" "}
                          {report.crypto.keyGrants.accepted} accepted ·{" "}
                          {Object.keys(report.crypto.keyGrants.reasons).join(", ") || "no rejection"}
                        </Accordion.Body>
                      </Accordion.Panel>
                    </Accordion.Item>
                    <Accordion.Item>
                      <Accordion.Heading>
                        <Accordion.Trigger>
                          Storage detail
                          <Accordion.Indicator>
                            <IconChevronDown />
                          </Accordion.Indicator>
                        </Accordion.Trigger>
                      </Accordion.Heading>
                      <Accordion.Panel>
                        <Accordion.Body>
                          {report.indexedDb.total} raw events · {report.indexedDb.conversationRows}{" "}
                          conversation rows · {report.indexedDb.contactRows} contact rows
                        </Accordion.Body>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </div>
              </Tabs.Panel>

              <Tabs.Panel id="report" className="pt-4">
                <pre className="diagnostics-output" tabIndex={0} aria-label="Raw diagnostic report">
                  {formatWebDiagnostics(report)}
                </pre>
              </Tabs.Panel>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
