import { useState } from "react";
import { Send, Loader2, Zap } from "lucide-react";
import { useSmsOptions, useSmsSend } from "@/hooks/useSmsSend";
import { SmsOptions } from "@/components/SmsOptions";
import { MessageTextarea } from "@/components/MessageTextarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function SendPage() {
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [critical, setCritical] = useState(false);
  const options = useSmsOptions();
  const { send, busy, status } = useSmsSend();

  async function submit() {
    if (options.problem || busy || !to.trim() || !text.trim()) return;
    const body = text;
    if (await send(to.trim(), body, { priority: critical ? "critical" : "expiring",
      ...(options.android ? { subscriptionId: options.sim?.subscriptionId } : {}) }))
      setText(current => current === body ? "" : current);
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Send a message</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4">
          <div className="space-y-1">
            <Label>To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+989121234567" />
          </div>
          <div className="space-y-1">
            <Label>Text</Label>
            <MessageTextarea value={text} onChange={setText} onSend={() => void submit()} disabled={busy}
              placeholder="Message text" className="w-full rounded-md border border-input bg-background p-3 text-sm" />
            <SmsOptions text={text} options={options} />
          </div>
          <button
            type="button"
            onClick={() => setCritical((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors",
              critical ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-border text-muted-foreground hover:bg-accent"
            )}
          >
            <span className="flex items-center gap-2">
              <Zap className="size-4" /> Critical (purchase / renewal)
            </span>
            <span className={cn("h-5 w-9 rounded-full p-0.5 transition-colors", critical ? "bg-amber-500" : "bg-secondary")}>
              <span className={cn("block size-4 rounded-full bg-white transition-transform", critical && "translate-x-4")} />
            </span>
          </button>

          <p role="status" className="text-xs">{status}</p>

          <Button type="submit" className="w-full" disabled={busy || !to.trim() || !text.trim() || Boolean(options.problem)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
