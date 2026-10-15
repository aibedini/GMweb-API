import { useLayoutEffect, useRef } from "react";
import { growMessageTextarea, shouldSendMessage } from "../../../shared/smsComposer";

export function MessageTextarea({ value, onChange, onSend, disabled, placeholder, className }: {
  value: string; onChange: (value: string) => void; onSend: () => void;
  disabled?: boolean; placeholder?: string; className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (ref.current) growMessageTextarea(ref.current); }, [value]);
  return <textarea ref={ref} aria-label="Message" dir="auto" rows={2}
    value={value} disabled={disabled} placeholder={placeholder} className={className}
    style={{ minHeight: 64, maxHeight: 192, overflowY: "auto", resize: "none", whiteSpace: "pre-wrap" }}
    onChange={event => onChange(event.target.value)} onKeyDown={event => {
      if (!shouldSendMessage({ ...event, isComposing: event.nativeEvent.isComposing })) return;
      event.preventDefault(); if (!disabled && value.trim()) onSend();
    }} />;
}
