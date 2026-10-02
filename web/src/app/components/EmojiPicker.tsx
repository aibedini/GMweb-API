/**
 * Emoji picker.
 *
 * Deliberately dependency-free and lazy-loaded (`React.lazy`), because the two
 * mainstream packages were both rejected on evidence:
 *
 *   - `@emoji-mart/react` peers on `react ^16.8 || ^17 || ^18` — no React 19.
 *   - `emoji-picker-react` is React-19 compatible but ships 40 MB unpacked and
 *     fetches emoji artwork from a third-party CDN by default. An E2EE
 *     messenger that leaks "this user is composing a message, right now" to an
 *     external host, and that breaks offline, is not acceptable.
 *
 * A curated native-Unicode grid costs a few kB, makes zero network requests,
 * and renders each glyph with the platform emoji font — the SAME glyph the SMS
 * will carry, which is exactly what a user needs to see before sending.
 *
 * This module is the lazy chunk boundary: nothing here is in the initial
 * bundle.
 */
import { useMemo, useState } from "react";
import { SearchField } from "@heroui/react";
import { type EmojiCategory, EMOJI_GROUPS, searchEmoji, type EmojiEntry } from "./emojiData";import { IconSearch } from "./icons";

export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<EmojiCategory | "ALL">("ALL");

  const visible = useMemo(() => {
    const searched = searchEmoji(query);
    return category === "ALL" ? searched : searched.filter(entry => entry.category === category);
  }, [query, category]);

  return (
    <div className="emoji-picker" role="group" aria-label="Choose emoji">
      <div className="emoji-picker__search">
        <SearchField
          fullWidth
          variant="secondary"
          aria-label="Search emoji"
          value={query}
          onChange={setQuery}
        >
          <SearchField.Group>
            <SearchField.SearchIcon>
              <IconSearch width={14} height={14} aria-hidden />
            </SearchField.SearchIcon>
            <SearchField.Input placeholder="Search emoji" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      </div>

      <div className="emoji-picker__tabs" role="tablist" aria-label="Emoji categories">
        {EMOJI_GROUPS.map(group => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={category === group.id}
            className="emoji-picker__tab"
            title={group.label}
            onClick={() => { setCategory(group.id); setQuery(""); }}
          >
            <span aria-hidden="true">{group.glyph}</span>
            <span className="sr-only">{group.label}</span>
          </button>
        ))}
      </div>

      <div className="emoji-picker__grid" role="listbox" aria-label="Emoji">
        {visible.map((entry: EmojiEntry) => (
          <button
            key={entry.emoji}
            type="button"
            role="option"
            aria-selected={false}
            aria-label={entry.name}
            title={entry.name}
            className="emoji-picker__cell"
            // Keep focus in the draft textarea: preventing the default on
            // pointerdown AND mousedown stops the button stealing focus, so the
            // caret the user left in the composer survives every insertion.
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry.emoji)}
          >
            <span aria-hidden="true">{entry.emoji}</span>
          </button>
        ))}
        {visible.length === 0 ? <p className="emoji-picker__empty">No emoji match that search.</p> : null}
      </div>
    </div>
  );
}
