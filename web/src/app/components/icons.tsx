/**
 * Single icon entry point for the GMweb PWA.
 *
 * §2 of the redesign: one consistent SVG icon system replaces the emoji
 * characters (👁 ✦ ✉ ↻ ＋ ⌕ ★ !) that used to be used as interface controls.
 * `@gravity-ui/icons` is the set HeroUI v3 documentation/examples use, so the
 * stroke weight and 16px optical size match HeroUI's own components.
 *
 * Every icon is imported through its OWN subpath. `@gravity-ui/icons` does not
 * declare `sideEffects: false`, so a barrel import from the package root would
 * defeat tree-shaking and pull the entire ~1000-icon set into the bundle.
 * Components must import icons from here, never from the package root.
 */

export { default as IconChat } from "@gravity-ui/icons/Comments";
export { default as IconChatActive } from "@gravity-ui/icons/CommentFill";
export { default as IconContacts } from "@gravity-ui/icons/Persons";
export { default as IconPerson } from "@gravity-ui/icons/Person";
export { default as IconDevice } from "@gravity-ui/icons/Smartphone";
export { default as IconSecurity } from "@gravity-ui/icons/ShieldCheck";
export { default as IconDiagnostics } from "@gravity-ui/icons/ListCheck";
export { default as IconSettings } from "@gravity-ui/icons/Gear";
export { default as IconSun } from "@gravity-ui/icons/Sun";
export { default as IconMoon } from "@gravity-ui/icons/Moon";
export { default as IconSystem } from "@gravity-ui/icons/Display";
export { default as IconSync } from "@gravity-ui/icons/ArrowsRotateRight";
export { default as IconStatusDot } from "@gravity-ui/icons/CircleFill";
export { default as IconSignal } from "@gravity-ui/icons/Signal";
export { default as IconLinked } from "@gravity-ui/icons/Eye";
export { default as IconBack } from "@gravity-ui/icons/ArrowLeft";
export { default as IconSend } from "@gravity-ui/icons/PaperPlane";
export { default as IconCompose } from "@gravity-ui/icons/Plus";
export { default as IconSearch } from "@gravity-ui/icons/Magnifier";
export { default as IconClose } from "@gravity-ui/icons/Xmark";
export { default as IconMore } from "@gravity-ui/icons/EllipsisVertical";
export { default as IconDetails } from "@gravity-ui/icons/CircleInfo";
export { default as IconCopy } from "@gravity-ui/icons/Copy";
export { default as IconCheck } from "@gravity-ui/icons/Check";
export { default as IconWarning } from "@gravity-ui/icons/TriangleExclamation";
export { default as IconError } from "@gravity-ui/icons/CircleXmark";
export { default as IconLock } from "@gravity-ui/icons/Lock";
export { default as IconKey } from "@gravity-ui/icons/Key";
export { default as IconClock } from "@gravity-ui/icons/Clock";
export { default as IconCalendar } from "@gravity-ui/icons/Calendar";
export { default as IconBell } from "@gravity-ui/icons/Bell";
export { default as IconStorage } from "@gravity-ui/icons/Database";
export { default as IconEdit } from "@gravity-ui/icons/Pencil";
export { default as IconSignOut } from "@gravity-ui/icons/ArrowRightFromSquare";
export { default as IconLink } from "@gravity-ui/icons/Link";
export { default as IconUnlink } from "@gravity-ui/icons/LinkSlash";
export { default as IconRetry } from "@gravity-ui/icons/ArrowDownToLine";
export { default as IconVerified } from "@gravity-ui/icons/CircleCheck";
export { default as IconPending } from "@gravity-ui/icons/CircleDashed";
export { default as IconReport } from "@gravity-ui/icons/FileText";
export { default as IconSliders } from "@gravity-ui/icons/Sliders";
export { default as IconChevronDown } from "@gravity-ui/icons/ChevronDown";
