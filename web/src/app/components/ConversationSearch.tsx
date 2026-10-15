import type { RefObject } from "react";
import { SearchField } from "@heroui/react";
import { IconSearch } from "./icons";

/**
 * §13/§31: HeroUI v3 SearchField. The input ref is exposed so the shell can
 * implement the Ctrl/Cmd+K focus shortcut without hijacking typing.
 */
export function ConversationSearch({
  value,
  onChange,
  inputRef,
  placeholder = "Search conversations",
  label = "Search conversations",
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  return (
    <SearchField
      fullWidth
      variant="secondary"
      aria-label={label}
      value={value}
      onChange={onChange}
    >
      <SearchField.Group>
        <SearchField.SearchIcon>
          <IconSearch width={15} height={15} aria-hidden />
        </SearchField.SearchIcon>
        <SearchField.Input ref={inputRef} placeholder={placeholder} autoFocus={autoFocus} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  );
}
