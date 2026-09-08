# ADR-005: One E2EE inbox for dashboard and PWA

The `/web` application is the only active conversations, contacts, and composer UI. Dashboard navigation exchanges its authenticated master/passkey session at `POST /api/v1/auth/bridge-linked-session`, receives the same capability-scoped HttpOnly linked-session cookie used by pairing, and redirects to `/web`.

Existing linked-browser certificates must be re-approved to receive `CONTACTS_READ` and its signed `CONTACTS_KEY_GRANT`. Legacy plaintext conversations remain an archive only and are hidden by default (`SHOW_LEGACY_ARCHIVE=false`).
