import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Card, Chip } from "@heroui/react";
import { beginPairing, type PairingHandle, type PairingProgress } from "../lib/pairing";
import { loginWithPwaToken } from "../lib/adminAccess";

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
  const compatible = apiVersion === pwaVersion;

  const start = async () => {
    if (startedRef.current || !compatible) return;
    setError(null);
    startedRef.current = true;
    try {
      const h = await beginPairing((next) => setStage(next));
      setHandle(h);
      setSecondsLeft(Math.max(0, Math.round((h.qr.expiresAt - Date.now()) / 1000)));
      setQrDataUrl(await QRCode.toDataURL(JSON.stringify(h.qr), { width: 240, margin: 1 }));
      void h.wait().then(async (link) => {
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
        if (!/cancel/i.test(String(cause))) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStage("FAILED");
        }
        startedRef.current = false;
        setHandle(null);
        setQrDataUrl(null);
      });
    } catch (cause) {
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
    <div className="min-h-full overflow-y-auto px-4 py-8">
      <Card className="mx-auto w-full max-w-lg">
        <div className="flex flex-col items-center gap-4 p-6 sm:p-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Messages</h1>
            <p className="mt-1 text-base font-medium">Link this browser</p>
          </div>

          <div className="flex flex-wrap justify-center gap-2 text-xs">
            <Chip size="sm" variant="soft" color={compatible ? "success" : "danger"}>API {apiVersion}</Chip>
            <Chip size="sm" variant="soft" color={compatible ? "success" : "danger"}>PWA {pwaVersion}</Chip>
            <Chip size="sm" variant="soft">{scriptFile}</Chip>
          </div>

          {!compatible && (
            <div className="w-full rounded-lg border p-3 text-sm" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              Deployment mismatch: the API and loaded PWA are different versions. Hard-refresh after the server update before pairing.
            </div>
          )}

          {compatible && qrDataUrl && <img src={qrDataUrl} alt="Pairing QR code" width={240} height={240} />}

          {compatible && !qrDataUrl && !error && (
            <p className="text-sm" style={{ color: "var(--muted-fg)" }}>{STAGE_LABELS[stage]}…</p>
          )}

          {error && (
            <div className="w-full rounded-lg border p-3 text-sm" style={{ borderColor: "var(--danger)" }}>
              <p className="font-medium" style={{ color: "var(--danger)" }}>{STAGE_LABELS[stage]}</p>
              <p className="mt-1 break-words" style={{ color: "var(--muted-fg)" }}>{error}</p>
            </div>
          )}

          {compatible && (
            <div className="flex w-full flex-col items-center gap-3">
              <p className="text-center text-sm" style={{ color: "var(--muted-fg)" }}>
                Current stage: <b style={{ color: "var(--fg)" }}>{STAGE_LABELS[stage]}</b>
                {handle ? <><br />Session {handle.session.pairingSessionId.slice(0, 10)}…</> : null}
              </p>
              {handle && qrDataUrl && (
                <>
                  <Chip
                    size="sm"
                    variant="soft"
                    color="warning"
                  >
                    Primary phone enrollment required first
                  </Chip>
                  <p className="text-center text-sm" style={{ color: "var(--muted-fg)" }}>
                    Android Messages → Settings → Linked devices → <b>Link new device</b>
                  </p>
                  {(
                    <p className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--border)", color: "var(--muted-fg)" }}>
                      For a new or reinstalled phone, first create a phone setup QR in the dashboard and scan it using Enroll this phone as Primary. Then return here to link this browser.
                    </p>
                  )}
                  <Chip size="sm" variant="soft" color={secondsLeft > 20 ? "default" : "warning"}>QR expires in {mm}:{ss}</Chip>
                </>
              )}
              {!handle && !tokenBusy && (
                <Button variant="primary" onPress={() => void start()}>Generate fresh QR</Button>
              )}
            </div>
          )}

          <div className="w-full border-t pt-4" style={{ borderColor: "var(--border)" }}>
            <Button variant="ghost" size="sm" className="w-full" onPress={() => setShowAlternative((value) => !value)}>
              {showAlternative ? "Hide alternative" : "Can't scan? Use a one-time PWA token"}
            </Button>
            {showAlternative && (
              <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void useAdminToken(); }}>
                <p className="text-xs" style={{ color: "var(--muted-fg)" }}>
                  In the GMweb dashboard, open <b>PWA Access</b>, create a short-lived token, and paste it here. The master API token is not accepted.
                </p>
                <input
                  aria-label="One-time PWA access token"
                  type="password"
                  value={accessToken}
                  onChange={(event) => setAccessToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pwa_…"
                  className="h-11 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus:ring-2"
                  style={{ borderColor: "var(--border)" }}
                />
                <Button type="submit" variant="primary" className="w-full" isDisabled={!accessToken.trim() || tokenBusy}>
                  {tokenBusy ? "Checking token…" : "Open Messages securely"}
                </Button>
              </form>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
