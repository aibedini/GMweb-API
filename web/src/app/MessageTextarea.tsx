import { useLayoutEffect, useRef, type RefObject } from "react";
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
 * `textareaRef` publishes the DOM node so the emoji picker can read
 * `selectionStart`/`selectionEnd` and restore the caret after inserting.
 */
export function MessageTextarea({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  className,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (ref.current) growMessageTextarea(ref.current);
  }, [value]);

  return (
    <TextArea
      ref={(node: HTMLTextAreaElement | null) => {
        ref.current = node;
        if (textareaRef) textareaRef.current = node;
        // The ref callback receives the node before layout; grow immediately so
        // a restored draft is sized correctly on first paint.
        if (node) growMessageTextarea(node);
      }}
      aria-label="Message"
      dir="auto"
      rows={1}
      variant="secondary"
      // HeroUI's `.textarea` sets no width, and a bare <textarea> falls back to
      // its ~20-column default — which rendered as a tiny pill inside the wide
      // composer shell. `fullWidth` is the component's own API for this.
      fullWidth
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      style={{
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        minWidth: 0,
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
