export const PWA_BUILD_VERSION = __GMWEB_VERSION__;

export function loadedScriptFile(): string {
  const scripts = Array.from(document.scripts);
  const src = scripts.map((script) => script.src).find((value) => /\/web\/assets\/index-[^/]+\.js(?:\?|$)/.test(value));
  if (!src) return "development";
  try {
    return new URL(src).pathname.split("/").pop() || "unknown";
  } catch {
    return "unknown";
  }
}
