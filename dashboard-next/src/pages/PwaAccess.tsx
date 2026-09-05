import { useEffect, useState } from "react";
import { Check, Clock3, Copy, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PwaToken = {
  id: string;
  label: string;
  tokenPreview: string;
  status: "READY" | "USED" | "EXPIRED" | "REVOKED";
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
  deviceId: string | null;
};

const statusVariant = (status: PwaToken["status"]) =>
  status === "READY" ? "success" : status === "REVOKED" ? "destructive" : "secondary";

export function PwaAccessPage() {
  const [tokens, setTokens] = useState<PwaToken[]>([]);
  const [label, setLabel] = useState("My browser");
  const [minutes, setMinutes] = useState("15");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const result = await api<{ tokens: PwaToken[] }>("/admin/pwa-access-tokens", { headers: { "Content-Type": "text/plain" } });
      setTokens(result.tokens);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load PWA access tokens.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: PwaToken & { token: string } }>("/admin/pwa-access-tokens", {
        method: "POST",
        body: { label: label.trim(), expiresInMinutes: Number(minutes) },
      });
      setFreshToken(result.token.token);
      setCopied(false);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: PwaToken) {
    const consequence = token.status === "USED"
      ? "This also signs that browser out immediately."
      : "The token will stop working immediately.";
    if (!confirm(`Revoke “${token.label}”? ${consequence}`)) return;
    await api(`/admin/pwa-access-tokens/${token.id}`, { method: "DELETE" });
    await load();
  }

  async function copyToken() {
    if (!freshToken) return;
    await navigator.clipboard.writeText(freshToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border bg-primary/5">
            <div>
              <CardTitle>PWA access tokens</CardTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Create a short-lived, one-use key for opening Messages without scanning a QR.</p>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><KeyRound className="size-4" /></div>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            <form onSubmit={create} className="grid gap-3 sm:grid-cols-[1fr_150px_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="pwa-token-label">Browser name</Label>
                <Input id="pwa-token-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pwa-token-ttl">Expires in</Label>
                <div className="relative">
                  <Input id="pwa-token-ttl" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="pr-12" required />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">min</span>
                </div>
              </div>
              <Button type="submit" disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Create</Button>
            </form>

            {freshToken && (
              <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-300"><ShieldCheck className="size-4" />Copy now — shown once</div>
                <p className="mt-1 text-xs text-muted-foreground">Paste this in the alternative access field on <code>/web</code>. It expires and can be used only once.</p>
                <div className="mt-3 flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 text-xs">{freshToken}</code>
                  <Button type="button" variant="secondary" onClick={copyToken}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy"}</Button>
                </div>
              </div>
            )}

            {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

            <div className="divide-y divide-border border-y border-border">
              {tokens.map((token) => (
                <div key={token.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Clock3 className="size-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{token.label}</span><Badge variant={statusVariant(token.status)}>{token.status.toLowerCase()}</Badge></div>
                    <div className="mt-1 text-xs text-muted-foreground"><span className="font-mono">{token.tokenPreview}</span> · created {new Date(token.createdAt).toLocaleString()} · expires {new Date(token.expiresAt).toLocaleString()}</div>
                  </div>
                  {token.status !== "REVOKED" && <Button size="sm" variant="ghost" onClick={() => void revoke(token)}><Trash2 className="size-4 text-red-400" />Revoke</Button>}
                </div>
              ))}
              {tokens.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">No PWA tokens have been created.</div>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader><CardTitle>Security model</CardTitle><ShieldCheck className="size-4 text-emerald-400" /></CardHeader>
        <CardContent className="space-y-3 p-5 text-xs leading-relaxed text-muted-foreground">
          <p><strong className="text-foreground">Separate from the master token.</strong> This key cannot control the API, dashboard, Android pairing routes, or server settings.</p>
          <p><strong className="text-foreground">Hash-only storage.</strong> GMweb stores SHA-256, not the usable token. The full value appears only after creation.</p>
          <p><strong className="text-foreground">One use, short expiry.</strong> A successful exchange burns the token and creates a restricted HttpOnly, Secure, SameSite session.</p>
          <p><strong className="text-foreground">Revocable.</strong> Revoking a used token also invalidates the browser session it created.</p>
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-amber-200/80">Treat the value like a temporary password. Send it only over a trusted channel and keep HTTPS enabled.</div>
        </CardContent>
      </Card>
    </div>
  );
}
