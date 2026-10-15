import type { ComponentType, SVGProps } from "react";
import {
  IconChat,
  IconContacts,
  IconDevice,
  IconDiagnostics,
  IconSecurity,
  IconSettings,
} from "./icons";
import type { DestinationKey } from "./types";

export interface DestinationMeta {
  key: DestinationKey;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * Single source of truth for the information architecture (§5).
 *
 * Desktop shows every destination in the rail; the compact breakpoints use a
 * five-slot bottom navigation, so Diagnostics moves into Settings there rather
 * than being silently dropped.
 */
export const RAIL_DESTINATIONS: DestinationMeta[] = [
  { key: "inbox", label: "Messages", Icon: IconChat },
  { key: "contacts", label: "Contacts", Icon: IconContacts },
  { key: "connection", label: "Device", Icon: IconDevice },
  { key: "security", label: "Security", Icon: IconSecurity },
  { key: "debug", label: "Diagnostics", Icon: IconDiagnostics },
];

export const MOBILE_DESTINATIONS: DestinationMeta[] = [
  { key: "inbox", label: "Messages", Icon: IconChat },
  { key: "contacts", label: "Contacts", Icon: IconContacts },
  { key: "connection", label: "Device", Icon: IconDevice },
  { key: "security", label: "Security", Icon: IconSecurity },
  { key: "settings", label: "Settings", Icon: IconSettings },
];

export const SETTINGS_DESTINATION: DestinationMeta = {
  key: "settings",
  label: "Settings",
  Icon: IconSettings,
};

export const DESTINATION_TITLES: Record<DestinationKey, { title: string; subtitle: string }> = {
  inbox: { title: "Messages", subtitle: "Encrypted conversations synced from your phone" },
  contacts: { title: "Contacts", subtitle: "Encrypted phone book from the Primary device" },
  connection: { title: "Device", subtitle: "PWA, Android sync and trust registry state" },
  security: { title: "Security", subtitle: "Credentials and identities visible to this browser" },
  debug: { title: "Diagnostics", subtitle: "Privacy-safe counts across the whole pipeline" },
  settings: { title: "Settings", subtitle: "Appearance, linked devices and this build" },
};
