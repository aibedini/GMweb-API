/**
 * Ctrl/Cmd+Enter always sends. With `enterToSend`, a plain Enter sends too and
 * Shift+Enter stays a new line. Never while an IME is composing (Enter there
 * confirms the candidate, it is not a send).
 */
export function shouldSendMessage(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; shiftKey?: boolean },
  options: { enterToSend?: boolean } = {},
): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return options.enterToSend === true && !event.shiftKey;
}
export function growMessageTextarea(node: HTMLTextAreaElement): void {
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, 192)}px`;
}
