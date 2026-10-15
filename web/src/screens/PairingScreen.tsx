import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Alert, Button, Card, Chip } from "@heroui/react";
import { beginPairing, type PairingHandle, type PairingProgress } from "../lib/pairing";
import { loginWithPwaToken } from "../lib/adminAccess";
import { wipeDeviceKeys } from "../lib/deviceKeys";
import { resetLocal } from "../lib/sync";
import { IconCopy, IconKey, IconLock } from "../app/components/icons";

export interface LinkContext {
  pairingSessionId: string;
  pollSecret: string;
  deviceId: string;
  certificate: string;
  origin: string;
}

type UiStage = PairingProgress | "CREATING_LINKED_SESSION" | "TOKEN_LOGIN" | "LINKED" | "FAILED";

const STAGE_LABELS: Record<UiStage, string> = {
  PREPARING_KEYS: "Preparing browser keys",
  CREATING_SESSION: "Creating pairing session",
  AWAITING_ANDROID: "Waiting for Android scan",
  ANDROID_APPROVED: "Android approved",
  VERIFYING_CERTIFICATE: "Verifying device certificate",
  CERTIFICATE_VERIFIED: "Certificate verified",
  CREATING_LINKED_SESSION: "Creating secure browser session",
  TOKEN_LOGIN: "Checking one-time PWA token",
  LINKED: "Linked",
  FAILED: "Stopped with an error",
};

interface PairingScreenProps {
  apiVersion: string;
  pwaVersion: string;
  scriptFile: string;
  onLinked: (link: LinkContext) => void | Promise<void>;
  onRecoveryLinked: () => void | Promise<void>;
}

/**
 * §58: pairing is VISUAL only. WebAuthn, the pairing protocol, polling,
 * device identity, certificate logic and session establishment are unchanged;
 * only the presentation moved onto HeroUI v3 semantic tokens.
 */
export function PairingScreen({
  apiVersion,
  pwaVersion,
  scriptFile,
  onLinked,
  onRecoveryLinked,
}: PairingScreenProps) {
  const [handle, setHandle] = useState<PairingHandle | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<UiStage>("PREPARING_KEYS");
  const [showAlternative, setShowAlternative] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const startedRef = useRef(false);
  const attemptRef = useRef(0);
  const compatible = apiVersion === pwaVersion;

  const start = async () => {
    if (startedRef.current || !compatible) return;
    setError(null);
    startedRef.current = true;
    const attempt = ++attemptRef.current;
    try {
      const h = await beginPairing((next) => setStage(next));
      if (attempt !== attemptRef.current) { h.cancel(); return; }
      setHandle(h);
      setSecondsLeft(Math.max(0, Math.round((h.qr.expiresAt - Date.now()) / 1000)));
      // The Android app resolves this one-time code to the authenticated full
      // transcript. Keeping public keys out of the optical payload makes the
      // QR low-density and reliable on laptop displays and phone cameras.
      const compactQr = `GMWEB:PAIR:1:${h.pairingCode}`;
      setQrDataUrl(await QRCode.toDataURL(compactQr, {
        width: 336,
        margin: 4,
        errorCorrectionLevel: "M",
      }));
      void h.wait().then(async (link) => {
        if (attempt !== attemptRef.current) return;
        setHandle(null); // Approval verified: QR expiry must not cancel cookie establishment.
        setQrDataUrl(null);
        setStage("CREATING_LINKED_SESSION");
        await onLinked({
          pairingSessionId: h.session.pairingSessionId,
          pollSecret: h.session.pollSecret,
          deviceId: link.deviceId,
          certificate: link.certificate,
          origin: h.qr.origin,
        });
        setStage("LINKED");
      }).catch((cause: unknown) => {
        if (attempt !== attemptRef.current) return;
        if (!/cancel/i.test(String(cause))) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStage("FAILED");
        }
        startedRef.current = false;
        setHandle(null);
        setQrDataUrl(null);
      });
    } catch (cause) {
      if (attempt !== attemptRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("FAILED");
      startedRef.current = false;
    }
  };

  useEffect(() => {
    if (compatible) void start();
    // start is guarded by startedRef; StrictMode must not create two sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatible]);

  useEffect(() => {
    if (!handle) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          handle.cancel();
          setHandle(null);
          setQrDataUrl(null);
          setError("QR expired. Generate a fresh code or use a one-time PWA token.");
          setStage("FAILED");
          startedRef.current = false;
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [handle]);

  const useAdminToken = async () => {
    const submitted = accessToken.trim();
    if (!submitted || tokenBusy) return;
    setAccessToken("");
    setTokenBusy(true);
    setError(null);
    setStage("TOKEN_LOGIN");
    handle?.cancel();
    try {
      await loginWithPwaToken(submitted);
      await onRecoveryLinked();
      setStage("LINKED");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("FAILED");
    } finally {
      setTokenBusy(false);
    }
  };

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="pairing-shell">
      <Card className="pairing-card">
        <Card.Content className="flex flex-col items-center gap-5 p-6 sm:p-8">
          <div className="pairing-brand">
            <span className="pairing-brand__mark" aria-hidden="true">M</span>
            <div>
              <h1 className="view-title" style={{ fontSize: 18 }}>GMweb Messages</h1>
              <p className="view-subtitle" style={{ marginTop: 2 }}>Link this browser to your phone</p>
            </div>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            <Chip size="sm" variant="soft" color={compatible ? "success" : "danger"}>
              <Chip.Label>API {apiVersion}</Chip.Label>
            </Chip>
            <Chip size="sm" variant="soft" color={compatible ? "success" : "danger"}>
              <Chip.Label>PWA {pwaVersion}</Chip.Label>
            </Chip>
            <Chip size="sm" variant="soft">
              <Chip.Label>{scriptFile}</Chip.Label>
            </Chip>
          </div>

          {!compatible ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Deployment mismatch</Alert.Title>
                <Alert.Description>
                  The API and the loaded PWA are different versions. Hard-refresh after the server update
                  before pairing.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {compatible && qrDataUrl ? (
            <div className="pairing-qr">
              <img src={qrDataUrl} alt="Pairing QR code" width={336} height={336} />
            </div>
          ) : null}

          {compatible ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                ++attemptRef.current;
                handle?.cancel();
                setHandle(null);
                setQrDataUrl(null);
                startedRef.current = false;
                void Promise.all([wipeDeviceKeys(), resetLocal()]).then(start).catch((cause) => setError(String(cause)));
              }}
            >
              Reset browser identity and pair again
            </Button>
          ) : null}

          {compatible && !qrDataUrl && !error ? (
            <p className="text-sm text-muted" role="status">
              {STAGE_LABELS[stage]}…
            </p>
          ) : null}

          {error ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{STAGE_LABELS[stage]}</Alert.Title>
                <Alert.Description>{error}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {compatible ? (
            <div className="flex w-full flex-col items-center gap-3">
              <p className="text-center text-sm text-muted" role="status">
                Current stage: <b className="text-foreground">{STAGE_LABELS[stage]}</b>
                {handle ? (
                  <>
                    <br />
                    Session {handle.session.pairingSessionId.slice(0, 10)}…
                  </>
                ) : null}
              </p>

              {handle && qrDataUrl ? (
                <>
                  <Chip size="sm" variant="soft" color={handle.primaryVerified ? "success" : "warning"}>
                    <Chip.Label>
                      {handle.primaryVerified ? "Primary phone verified" : "Primary phone enrollment required"}
                    </Chip.Label>
                  </Chip>

                  <ol className="pairing-steps">
                    <li>Open Android Messages on your Primary phone.</li>
                    <li>Go to Settings → Linked devices → Link new device.</li>
                    <li>Scan the code above.</li>
                  </ol>

                  {!handle.primaryVerified ? (
                    <Alert status="warning">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>
                          For a new or reinstalled phone, first create a phone setup QR in the dashboard and
                          scan it using &ldquo;Enroll this phone as Primary&rdquo;. Then return here to link
                          this browser.
                        </Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}

                  <Chip size="sm" variant="soft" color={secondsLeft > 20 ? "default" : "warning"}>
                    <Chip.Label>QR expires in {mm}:{ss}</Chip.Label>
                  </Chip>

                  <div className="w-full rounded-xl border border-border p-3 text-center">
                    <p className="text-xs text-muted">Can&apos;t scan? Enter this pairing code on Android</p>
                    <code className="mt-1 block text-lg font-semibold tracking-[0.2em]">
                      {handle.pairingCode.match(/.{1,5}/g)?.join(" ")}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Copy pairing code"
                      onPress={() => void navigator.clipboard.writeText(handle.pairingCode)}
                    >
                      <IconCopy width={15} height={15} aria-hidden />
                      <span>Copy</span>
                    </Button>
                  </div>
                </>
              ) : null}

              {!handle && !tokenBusy ? (
                <Button variant="primary" onPress={() => void start()}>
                  Generate fresh QR
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="w-full border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              onPress={() => setShowAlternative((value) => !value)}
            >
              <IconKey width={15} height={15} aria-hidden />
              <span>{showAlternative ? "Hide alternative" : "Can't scan? Use a one-time PWA token"}</span>
            </Button>

            {showAlternative ? (
              <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void useAdminToken();
                }}
              >
                <p className="text-xs text-muted">
                  In the GMweb dashboard, open <b className="text-foreground">PWA Access</b>, create a
                  short-lived token, and paste it here. The master API token is not accepted.
                </p>
                <input
                  aria-label="One-time PWA access token"
                  type="password"
                  value={accessToken}
                  onChange={(event) => setAccessToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pwa_…"
                  className="w-full rounded-field border border-field-border bg-field px-3 py-2.5 text-sm text-field-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus"
                />
                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  isDisabled={!accessToken.trim() || tokenBusy}
                >
                  <IconLock width={15} height={15} aria-hidden />
                  <span>{tokenBusy ? "Checking token…" : "Open Messages securely"}</span>
                </Button>
              </form>
            ) : null}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
