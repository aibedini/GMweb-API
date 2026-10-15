import { Avatar, Button, EmptyState } from "@heroui/react";
import type { StoredContact } from "../../lib/sync";
import { ConversationSearch } from "./ConversationSearch";
import { initialsFor } from "./format";
import { IconBack, IconSend } from "./icons";

function looksLikeNumber(value: string): boolean {
  return /^\+?[0-9\s()\-.]+$/.test(value.trim()) && value.replace(/\D/g, "").length >= 3;
}

/**
 * §41: New message flow.
 *
 * Desktop renders this inside the thread area; mobile renders it as a
 * full-screen view (the same component — only the container differs). Manual
 * number entry still works, and no backend object is created before a message
 * is actually sent.
 */
export function NewMessageView({
  recipientSearch,
  onRecipientSearch,
  matches,
  contactsAvailable,
  contactsAccessMissing,
  onPickRecipient,
  onBack,
  autoFocus = true,
}: {
  recipientSearch: string;
  onRecipientSearch: (value: string) => void;
  matches: StoredContact[];
  contactsAvailable: boolean;
  contactsAccessMissing: boolean;
  onPickRecipient: (phone: string) => void;
  onBack: () => void;
  autoFocus?: boolean;
}) {
  const manualNumber = looksLikeNumber(recipientSearch)
    ? recipientSearch.replace(/[^+0-9]/g, "")
    : null;

  return (
    <section className="thread-pane" aria-label="New message">
      <header className="thread-header">
        <Button
          variant="ghost"
          isIconOnly
          className="thread-header__back"
          aria-label="Back to conversations"
          onPress={onBack}
        >
          <IconBack width={18} height={18} aria-hidden />
        </Button>
        <div className="thread-header__copy">
          <span className="thread-header__title">New message</span>
          <span className="thread-header__subtitle">Choose a contact or enter a phone number</span>
        </div>
      </header>

      <div className="recipient-picker">
        <ConversationSearch
          value={recipientSearch}
          onChange={onRecipientSearch}
          placeholder="Search contacts or type a number"
          label="Recipient"
          autoFocus={autoFocus}
        />

        <div className="recipient-results">
          {manualNumber ? (
            <button
              type="button"
              className="recipient-row recipient-row--manual"
              onClick={() => onPickRecipient(manualNumber)}
            >
              <Avatar size="sm" variant="soft" color="accent">
                <Avatar.Fallback>{manualNumber.slice(-2)}</Avatar.Fallback>
              </Avatar>
              <span className="recipient-row__copy">
                <span className="recipient-row__name">Send to {recipientSearch.trim()}</span>
                <span className="recipient-row__phone">Use this number directly</span>
              </span>
              <span className="contact-row__action" aria-hidden>
                <IconSend width={16} height={16} />
              </span>
            </button>
          ) : null}

          {matches.map((contact) => (
            <button
              key={contact.normalizedPhone}
              type="button"
              className="recipient-row"
              onClick={() => onPickRecipient(contact.normalizedPhone)}
            >
              <Avatar size="sm" variant="soft" color="accent">
                <Avatar.Fallback>{initialsFor(contact.displayName)}</Avatar.Fallback>
              </Avatar>
              <span className="recipient-row__copy">
                <span className="recipient-row__name bidi-text">{contact.displayName}</span>
                <span className="recipient-row__phone">{contact.normalizedPhone}</span>
              </span>
              <span className="contact-row__action" aria-hidden>
                <IconSend width={16} height={16} />
              </span>
            </button>
          ))}

          {matches.length === 0 && !manualNumber ? (
            <EmptyState className="empty-block">
              {contactsAccessMissing ? (
                <>
                  <h3>Contacts access was not approved</h3>
                  <p>Re-link or re-approve this browser, or type a phone number above.</p>
                </>
              ) : contactsAvailable ? (
                <>
                  <h3>No matching contacts</h3>
                  <p>Type a full phone number to message a number that is not in your phone book.</p>
                </>
              ) : (
                <>
                  <h3>Contacts are still syncing</h3>
                  <p>You can still type a phone number to start a conversation.</p>
                </>
              )}
            </EmptyState>
          ) : null}
        </div>
      </div>
    </section>
  );
}
