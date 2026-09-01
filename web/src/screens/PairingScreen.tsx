/**
 * ADR-007 — first-run Linked-Device pairing screen.
 *
 * UX contract (§1): the ONLY first-run surface is "Link this browser to your
 * phone" with a QR + countdown + pairing-code fallback. No passkey, no
 * account password, no TOTP, no recovery codes. Passkey returns later as
 * OPTIONAL hardening behind Security Center (§7).
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, Card, Chip } from "@heroui/react";
import { beginPairing, type PairingHandle } from "../lib/pairing";

export function PairingScreen({ onLinked }: { onLinked: () => void }) {
  const [handle, setHandle] = useState<PairingHandle | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  void canvasRef;
  const startedRef = useRef(false);

  const start = async () => {
    setError(null);
    startedRef.current = true;
    try {
      const h = await beginPairing();
      setHandle(h);
      setSecondsLeft(Math.max(0, Math.round((h.qr.expiresAt - Date.now()) / 1000)));
      const payload = JSON.stringify(h.qr);
      setQrDataUrl(await QRCode.toDataURL(payload, { width: 240, margin: 1 }));
      void h
        .wait()
        .then(() => onLinked())
        .catch((e) => {
          if (!/cancel/i.test(String(e))) setError(e.message);
          startedRef.current = false;
          setHandle(null);
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      startedRef.current = false;
    }
  };

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // countdown + auto-refresh at expiry
  useEffect(() => {
    if (!handle) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(t);
          setHandle(null);
          setQrDataUrl(null);
          startedRef.current = false;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [handle]);

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <div className="flex flex-col items-center gap-4 p-8">
          <h1 className="text-2xl font-semibold">Messages</h1>
          <p className="text-base font-medium">Link to your Android</p>

          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Pairing QR code" width={240} height={240} />
          ) : error ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm" style={{ color: "var(--danger)" }}>
                {error}
              </p>
              <Button
                variant="primary"
                onPress={() => {
                  setError(null);
                  void start();
                }}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--muted-fg)" }}>
              Preparing pairing session…
            </p>
          )}

          {handle && qrDataUrl && (
            <>
              <p className="text-center text-sm" style={{ color: "var(--muted-fg)" }}>
                Open Messages on your Android phone
                <br />
                Settings → Linked devices → <b>Link new device</b>
              </p>
              <Chip size="sm" variant="soft" color={secondsLeft > 20 ? "default" : "warning"}>
                QR expires in {mm}:{ss}
              </Chip>
              {showCode ? (
                <code className="rounded px-3 py-2 text-sm" style={{ background: "var(--border)" }}>
                  {handle.qr.nonce.slice(0, 4)} {handle.qr.nonce.slice(4, 8)}
                </code>
              ) : (
                <Button variant="ghost" size="sm" onPress={() => setShowCode(true)}>
                  Can't scan? Use pairing code
                </Button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
