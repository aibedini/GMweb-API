import { useLayoutEffect, useRef } from "react";
import { TextArea } from "@heroui/react";
import { growMessageTextarea, shouldSendMessage } from "../../../shared/smsComposer";

/**
 * §17: multiline draft textarea on HeroUI's `TextArea`.
 *
 * HeroUI v3's `TextArea` wraps React Aria's `TextArea`, whose props extend
 * `TextareaHTMLAttributes` — so `onChange` is the native change event and
 * `onKeyDown` is the native keyboard event. That keeps the shared
 * `shouldSendMessage` helper contract (`ctrl/meta + Enter`, IME-safe) intact.
 *
 * `growMessageTextarea` still caps the inline height; the CSS
 * `max-height` in `styles/messaging.css` provides the responsive ceiling.
 */
export function MessageTextarea({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (ref.current) growMessageTextarea(ref.current);
  }, [value]);

  return (
    <TextArea
      ref={ref}
      aria-label="Message"
      dir="auto"
      rows={1}
      variant="secondary"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      style={{
        minHeight: 44,
        overflowY: "auto",
        resize: "none",
        whiteSpace: "pre-wrap",
      }}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (
          !shouldSendMessage({
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          })
        ) {
          return;
        }

        event.preventDefault();

        if (!disabled && value.trim()) onSend();
      }}
    />
  );
}
