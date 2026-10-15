import type { ReactNode } from "react";

/**
 * §35: the application shell is a fixed viewport. It never scrolls; only the
 * explicitly marked `.scroll-region` children do.
 *
 * Layout: rail | (top bar + content), with an optional bottom navigation for
 * the compact breakpoints. Visibility of the rail and the bottom navigation is
 * decided entirely in CSS (`styles/responsive.css`) so behaviour does not
 * depend on a JS breakpoint that can lag a resize.
 */
export function AppShell({
  sidebar,
  topbar,
  alerts,
  bottomNav,
  children,
}: {
  sidebar: ReactNode;
  topbar: ReactNode;
  alerts?: ReactNode;
  /** Omitted inside an active mobile conversation to reclaim vertical room. */
  bottomNav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <div className="app-body">
        {sidebar}
        <div className="app-main">
          {topbar}
          {alerts ? <div className="app-alerts">{alerts}</div> : null}
          <main className="app-content">{children}</main>
        </div>
      </div>
      {bottomNav}
    </div>
  );
}
