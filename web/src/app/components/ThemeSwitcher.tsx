import { useEffect } from "react";
import { Button, Dropdown, useTheme } from "@heroui/react";
import { IconMoon, IconSun, IconSystem } from "./icons";

const THEME_COLORS: Record<string, string> = {
  light: "#f7faf8",
  dark: "#0f1512",
};

const OPTIONS = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
] as const;

/**
 * §8/§46: HeroUI's `useTheme` — no `next-themes` (this is Vite, not Next.js).
 * `useTheme` persists the *intent* (`light` | `dark` | `system`) in
 * `localStorage["heroui-theme"]` and writes both the class and the
 * `data-theme` attribute that `styles/theme.css` keys off.
 */
export function ThemeSwitcher({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme("system");

  // Keep the browser chrome colour in step with the resolved theme.
  useEffect(() => {
    if (!resolvedTheme) return;
    const meta = document.querySelector('meta[name="theme-color"]');
    const next = THEME_COLORS[resolvedTheme];
    if (meta && next) meta.setAttribute("content", next);
  }, [resolvedTheme]);

  const Icon = theme === "light" ? IconSun : theme === "dark" ? IconMoon : IconSystem;
  const current = OPTIONS.find((option) => option.id === theme)?.label ?? "System";

  return (
    <Dropdown>
      <Button
        variant="ghost"
        isIconOnly
        className={className}
        aria-label={`Change theme (currently ${current})`}
      >
        <Icon width={17} height={17} aria-hidden />
      </Button>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label="Theme"
          selectionMode="single"
          selectedKeys={[theme]}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next === "light" || next === "dark" || next === "system") setTheme(next);
          }}
        >
          {OPTIONS.map((option) => (
            <Dropdown.Item key={option.id} id={option.id} textValue={option.label}>
              <Dropdown.ItemIndicator />
              <span>{option.label}</span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
