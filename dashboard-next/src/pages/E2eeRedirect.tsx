import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

export function E2eeRedirect() {
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ redirect: string }>("/api/v1/auth/bridge-linked-session", { method: "POST" })
      .then(result => window.location.assign(result.redirect || "/web"))
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  return <div className="flex items-center gap-3 text-sm text-muted-foreground">
    <Loader2 className="size-4 animate-spin" /> {error || "Opening the encrypted Messages inbox…"}
  </div>;
}
