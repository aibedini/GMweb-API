export function shouldSendMessage(event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing;
}
export function growMessageTextarea(node: HTMLTextAreaElement): void {
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, 192)}px`;
}
