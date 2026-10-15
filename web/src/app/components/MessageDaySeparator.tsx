/**
 * §16: day separator produced by a pure presentation transform of
 * `payload.dateMs` — stored events are never mutated.
 */
export function MessageDaySeparator({ label }: { label: string }) {
  return (
    <div className="message-day" role="presentation">
      <span>{label}</span>
    </div>
  );
}
