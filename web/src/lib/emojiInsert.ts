/**
 * Emoji insertion at the caret.
 *
 * A textarea exposes `selectionStart`/`selectionEnd` as **UTF-16 code unit**
 * offsets, and `String.prototype.length` is also UTF-16 code units. That means
 * inserting a whole emoji sequence (including ZWJ, variation selectors,
 * skin-tone modifiers and regional-indicator pairs) is consistent as long as we
 * treat the sequence as one atomic unit and never slice through it.
 *
 * Pure and unit-tested: no DOM access here.
 */

export interface EmojiInsertResult {
  value: string;
  /** UTF-16 offset the caret should be moved to afterwards. */
  caret: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Replace the current selection with `emoji` (or insert at the caret).
 *
 * @param value current draft
 * @param selectionStart UTF-16 offset, or null when the element is not focused
 * @param selectionEnd UTF-16 offset, or null
 * @param emoji one complete emoji sequence (may be several code points)
 */
export function insertEmoji(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  emoji: string,
): EmojiInsertResult {
  if (!emoji) return { value, caret: selectionStart ?? value.length };
  const length = value.length;

  // No measurable selection (never focused, or the element lost focus): append.
  if (selectionStart === null || selectionEnd === null ||
      !Number.isFinite(selectionStart) || !Number.isFinite(selectionEnd)) {
    return { value: value + emoji, caret: length + emoji.length };
  }

  // Tolerate reversed or out-of-range offsets rather than producing a corrupt
  // draft by slicing through a surrogate pair.
  const start = clamp(Math.min(selectionStart, selectionEnd), 0, length);
  const end = clamp(Math.max(selectionStart, selectionEnd), 0, length);

  return {
    value: value.slice(0, start) + emoji + value.slice(end),
    caret: start + emoji.length,
  };
}

/**
 * Split a draft into the emoji sequences it contains. Used by tests and by the
 * counter sanity checks; never re-encodes or normalises the input.
 */
export function countUnicodeSequences(value: string): number {
  return Array.from(value).length;
}

/**
 * True when the string contains any non-GSM-7 character, which is what forces
 * an SMS into UCS-2. Kept here so the composer and the counter agree.
 */
export function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}
