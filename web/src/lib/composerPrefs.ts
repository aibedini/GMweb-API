/** Per-browser composer preferences. Storage can be unavailable (private mode). */
const ENTER_TO_SEND_KEY = "gmweb:composer-enter-to-send";

export function readEnterToSend(): boolean {
  try {
    return window.localStorage.getItem(ENTER_TO_SEND_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeEnterToSend(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(ENTER_TO_SEND_KEY, "1");
    else window.localStorage.removeItem(ENTER_TO_SEND_KEY);
  } catch {
    // Not persisted; the toggle still applies for this page.
  }
}
