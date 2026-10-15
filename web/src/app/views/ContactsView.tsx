import { Avatar, Button, Card, EmptyState, Spinner } from "@heroui/react";
import type { StoredContact } from "../../lib/sync";
import { ConversationSearch } from "../components/ConversationSearch";
import { initialsFor, pluralize } from "../components/format";
import { IconSend, IconSync } from "../components/icons";

/**
 * §28: contacts list. Keeps the existing incremental rendering
 * (`visibleCount` + "Load more"), which is already lazy and performant, and
 * reuses the same SearchField design as the conversation pane.
 */
export function ContactsView({
  contacts,
  total,
  search,
  onSearch,
  visibleCount,
  onShowMore,
  busy,
  progress,
  checkedAt,
  error,
  onRefresh,
  canReadContacts,
  onPick,
}: {
  contacts: StoredContact[];
  total: number;
  search: string;
  onSearch: (value: string) => void;
  visibleCount: number;
  onShowMore: () => void;
  busy: boolean;
  progress: number;
  checkedAt: number | null;
  error: string | null;
  onRefresh: () => void;
  canReadContacts: boolean;
  onPick: (phone: string) => void;
}) {
  const visible = contacts.slice(0, visibleCount);

  return (
    <div
      className="view-scroll scroll-region"
      onScroll={(event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) onShowMore();
      }}
    >
      <div className="view-inner">
        <div className="view-head">
          <div className="view-head__copy">
            <p className="view-eyebrow">Phone book</p>
            <h1 className="view-title">Contacts</h1>
            <p className="view-subtitle">
              End-to-end encrypted contacts synced from the Primary Android device. Nothing is shown that
              the phone has not published.
            </p>
          </div>
          <Button variant="secondary" size="sm" onPress={onRefresh} isDisabled={busy || !canReadContacts}>
            {busy ? <Spinner size="sm" /> : <IconSync width={15} height={15} aria-hidden />}
            <span>{busy ? "Syncing…" : "Sync contacts"}</span>
          </Button>
        </div>

        <div className="text-xs text-muted" role="status">
          {busy
            ? `Syncing encrypted contacts… ${progress} event(s) checked`
            : error
              ? error
              : `${pluralize(total, "contact")} ready${
                  checkedAt ? ` · checked ${new Date(checkedAt).toLocaleTimeString()}` : ""
                }`}
        </div>

        <ConversationSearch
          value={search}
          onChange={onSearch}
          placeholder="Search names or numbers"
          label="Search contacts"
        />

        <div className="contact-list">
          {visible.map((contact) => (
            <button
              key={contact.normalizedPhone}
              type="button"
              className="contact-row"
              onClick={() => onPick(contact.normalizedPhone)}
            >
              <Avatar size="sm" variant="soft" color="accent">
                <Avatar.Fallback>{initialsFor(contact.displayName)}</Avatar.Fallback>
              </Avatar>
              <span className="contact-row__copy">
                <span className="contact-row__name bidi-text">{contact.displayName}</span>
                <span className="contact-row__phone">{contact.normalizedPhone}</span>
              </span>
              <span className="contact-row__action" aria-hidden>
                <IconSend width={16} height={16} />
              </span>
            </button>
          ))}

          {contacts.length === 0 ? (
            <Card>
              <Card.Content>
                <EmptyState className="empty-block empty-block--inline">
                  {!canReadContacts ? (
                    <>
                      <h3>Contacts access was not approved</h3>
                      <p>
                        Contacts access was not approved for this linked browser. Re-link or re-approve this
                        browser on your Primary phone.
                      </p>
                    </>
                  ) : total > 0 ? (
                    <>
                      <h3>No matching contacts</h3>
                      <p>Try a different name or phone number.</p>
                    </>
                  ) : (
                    <>
                      <h3>No contacts yet</h3>
                      <p>Phone sync or a contact key grant may still be pending.</p>
                    </>
                  )}
                </EmptyState>
              </Card.Content>
            </Card>
          ) : null}

          {contacts.length > visibleCount ? (
            <div className="list-footer">
              <Button variant="tertiary" size="sm" onPress={onShowMore}>
                Load more contacts
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
