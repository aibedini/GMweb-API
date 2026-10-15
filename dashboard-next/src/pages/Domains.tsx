import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Globe, Loader2, Lock, Plus, RefreshCw, Server, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Service = { id: string; label: string; pathPrefix: string; publicSurface: boolean; requiresAuth: boolean; description: string };

type Domain = {
  id: string;
  hostname: string;
  serviceId: string;
  serviceLabel: string | null;
  status: string;
  dns: { status: string | null; observed: string[]; checkedAt: string | null };
  routing: { status: string | null; checkedAt: string | null };
  proxy: { status: "NONE" | "APPLIED" | "STALE"; appliedServiceId: string | null; appliedAt: string | null };
  ssl: { status: string | null; issuer: string | null; notAfter: string | null; daysRemaining: number | null };
  autoRenew: boolean;
  lastError: { code: string; message: string } | null;
};

type Capability = {
  canVerifyDns: boolean;
  canVerifyRouting: boolean;
  canConfigureProxy: boolean;
  canIssueCertificate: boolean;
  canRenewCertificate: boolean;
  reason: string | null;
};

type ListResponse = { enabled: boolean; capability: Capability; domains: Domain[] };

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  SSL_ACTIVE: "success",
  READY_FOR_SSL: "warning",
  PENDING_DNS: "warning",
  RENEWAL_REQUIRED: "warning",
  DNS_INVALID: "destructive",
  ROUTING_ERROR: "destructive",
  SSL_INVALID: "destructive",
  EXPIRED: "destructive",
  CONFIGURATION_ERROR: "destructive",
};

const STATUS_LABEL: Record<string, string> = {
  SSL_ACTIVE: "SSL active",
  READY_FOR_SSL: "Ready for SSL",
  PENDING_DNS: "Waiting for DNS",
  DNS_INVALID: "DNS invalid",
  ROUTING_ERROR: "Routing error",
  SSL_INVALID: "SSL invalid",
  RENEWAL_REQUIRED: "Renewal required",
  EXPIRED: "Certificate expired",
  CONFIGURATION_ERROR: "Configuration error",
};

function message(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function DomainsCard() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [hostname, setHostname] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, svc] = await Promise.all([
        api<ListResponse>("/admin/domains"),
        api<{ services: Service[] }>("/admin/domains/services"),
      ]);
      setDomains(list.domains);
      setCapability(list.capability);
      setEnabled(list.enabled);
      setServices(svc.services);
      setServiceId((current) => current || svc.services[0]?.id || "");
    } catch (err) {
      setError(message(err, "Couldn't load domains."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setAdding(true);
    setError("");
    setNote("");
    try {
      await api("/admin/domains", { method: "POST", body: { hostname: hostname.trim(), serviceId } });
      setHostname("");
      await load();
    } catch (err) {
      setError(message(err, "Couldn't add the domain."));
    } finally {
      setAdding(false);
    }
  }

  async function run(id: string, action: string, fn: () => Promise<unknown>) {
    setBusy(`${id}:${action}`);
    setError("");
    setNote("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(message(err, "The request failed."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(domain: Domain) {
    if (!window.confirm(domain.proxy.status === "NONE" ? `Remove ${domain.hostname} from management?` : `Remove ${domain.hostname}? Its web-server entry will be removed too. The certificate is kept.`)) return;
    await run(domain.id, "remove", async () => {
      const result = await api<{ note?: string }>(`/admin/domains/${domain.id}`, { method: "DELETE" });
      if (result.note) setNote(result.note);
    });
  }

  if (loading) {
    return <div className="flex min-h-[120px] items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  const canApply = Boolean(capability?.canConfigureProxy);
  const canIssue = Boolean(capability?.canIssueCertificate);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent">
        <div>
          <CardTitle>Domains &amp; SSL</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Point domains at this GMweb server, choose what each one serves, and track DNS and certificate health.</p>
        </div>
        <div className="flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
          <Globe className="size-5" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        {!enabled && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">Domain management is disabled on this server.</div>
        )}
        {capability && (!canApply || !canIssue) && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/90">
            <div className="mb-1 font-medium">Verification only</div>
            {capability.reason} Until then you can record domains and check DNS and HTTPS, but the web-server entry and the certificate cannot be created from here.
          </div>
        )}

        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <div>
            <Label htmlFor="domain-host">Domain</Label>
            <Input id="domain-host" placeholder="sms.example.com" value={hostname} required autoComplete="off"
              onChange={(event) => setHostname(event.target.value)} className="mt-1.5 font-mono" />
          </div>
          <div>
            <Label htmlFor="domain-service">Serves</Label>
            <select id="domain-service" value={serviceId} onChange={(event) => setServiceId(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm">
              {services.map((service) => <option key={service.id} value={service.id} className="bg-background">{service.label}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={adding || !hostname.trim() || !serviceId}>
            {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add domain
          </Button>
        </form>
        {services.find((service) => service.id === serviceId)?.description && (
          <p className="-mt-3 text-xs text-muted-foreground">{services.find((service) => service.id === serviceId)?.description}</p>
        )}

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        {note && <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{note}</div>}

        {domains.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No domains yet. Add one above, then create its DNS record and run the checks.</div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {domains.map((domain) => {
              const isBusy = (action: string) => busy === `${domain.id}:${action}`;
              return (
                <li key={domain.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium">{domain.hostname}</span>
                        <Badge variant={STATUS_VARIANT[domain.status] ?? "secondary"}>{STATUS_LABEL[domain.status] ?? domain.status}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">Serves {domain.serviceLabel ?? domain.serviceId}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select aria-label={`Service for ${domain.hostname}`} value={domain.serviceId} disabled={busy !== null}
                        onChange={(event) => run(domain.id, "assign", () => api(`/admin/domains/${domain.id}/assign`, { method: "POST", body: { serviceId: event.target.value } }))}
                        className="h-8 rounded-md border border-border bg-transparent px-2 text-xs">
                        {services.map((service) => <option key={service.id} value={service.id} className="bg-background">{service.label}</option>)}
                      </select>
                      <Button size="sm" variant="outline" disabled={busy !== null}
                        onClick={() => run(domain.id, "dns", () => api(`/admin/domains/${domain.id}/verify-dns`, { method: "POST", body: {} }))}>
                        {isBusy("dns") ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check DNS
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== null}
                        onClick={() => run(domain.id, "routing", () => api(`/admin/domains/${domain.id}/verify-routing`, { method: "POST", body: {} }))}>
                        {isBusy("routing") ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Check HTTPS
                      </Button>
                      <Button size="sm" variant={domain.proxy.status === "APPLIED" ? "outline" : "default"}
                        disabled={busy !== null || !canApply}
                        title={canApply ? "Write this domain's web-server entry (HTTP until a certificate is issued)." : "Needs the privileged helper."}
                        onClick={() => run(domain.id, "apply", () => api(`/admin/domains/${domain.id}/apply`, { method: "POST", body: {} }))}>
                        {isBusy("apply") ? <Loader2 className="animate-spin" /> : <Server />}
                        {domain.proxy.status === "NONE" ? "Apply" : "Re-apply"}
                      </Button>
                      <Button size="sm" disabled={busy !== null || !canIssue || domain.proxy.status !== "APPLIED" || domain.dns.status !== "OK" || domain.ssl.status === "ACTIVE"}
                        title={!canIssue ? "Needs the privileged helper."
                          : domain.dns.status !== "OK" ? "Check DNS first: it must point at this server."
                          : domain.proxy.status !== "APPLIED" ? "Apply the domain first."
                          : domain.ssl.status === "ACTIVE" ? "A valid certificate is already active." : "Request a Let's Encrypt certificate."}
                        onClick={() => run(domain.id, "ssl", () => api(`/admin/domains/${domain.id}/issue-certificate`, { method: "POST", body: {} }))}>
                        {isBusy("ssl") ? <Loader2 className="animate-spin" /> : <Lock />} Get SSL
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${domain.hostname}`} disabled={busy !== null} onClick={() => remove(domain)}>
                        {isBusy("remove") ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </div>
                  </div>
                  <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                    <div><dt className="text-muted-foreground">Server entry</dt><dd className="font-mono">{domain.proxy.status === "NONE" ? "not applied" : domain.proxy.status === "STALE" ? "out of date: re-apply" : "applied"}</dd></div>
                    <div><dt className="text-muted-foreground">DNS</dt><dd className="font-mono">{domain.dns.status ?? "not checked"}{domain.dns.observed.length > 0 && ` · ${domain.dns.observed.join(", ")}`}</dd></div>
                    <div><dt className="text-muted-foreground">HTTPS routing</dt><dd className="font-mono">{domain.routing.status ?? "not checked"}</dd></div>
                    <div><dt className="text-muted-foreground">Certificate</dt><dd className="font-mono">{domain.ssl.status ?? "none observed"}{domain.ssl.daysRemaining !== null && ` · ${domain.ssl.daysRemaining}d left`}</dd></div>
                  </dl>
                  {domain.lastError && <div className="text-xs text-destructive">{domain.lastError.message}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
