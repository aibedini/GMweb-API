import { Avatar, Button, Dropdown, Tooltip, toast } from "@heroui/react";
import { initialsFor } from "./format";
import { IconBack, IconCopy, IconDetails, IconMore } from "./icons";

/**
 * §14: thread header.
 *
 * The Back control is a mobile-only affordance (hidden by CSS on desktop).
 * The "more" menu contains only actions that actually work — Details and
 * Copy phone number. There is no call button because GMweb has no call
 * capability.
 */
export function ThreadHeader({
  title,
  subtitle,
  phone,
  onBack,
  onDetails,
}: {
  title: string;
  subtitle?: string;
  phone?: string | null;
  onBack?: () => void;
  onDetails?: () => void;
}) {
  const copyPhone = () => {
    if (!phone) return;
    void navigator.clipboard
      .writeText(phone)
      .then(() => toast.success("Phone number copied"))
      .catch(() => toast.danger("Could not copy the phone number"));
  };

  return (
    <header className="thread-header">
      {onBack ? (
        <Button
          variant="ghost"
          isIconOnly
          className="thread-header__back"
          aria-label="Back to conversations"
          onPress={onBack}
        >
          <IconBack width={18} height={18} aria-hidden />
        </Button>
      ) : null}

      <Avatar size="sm" variant="soft" color="accent">
        <Avatar.Fallback>{initialsFor(title)}</Avatar.Fallback>
      </Avatar>

      <div className="thread-header__copy">
        <span className="thread-header__title bidi-text">{title}</span>
        {subtitle ? <span className="thread-header__subtitle bidi-text">{subtitle}</span> : null}
      </div>

      {onDetails ? (
        <Tooltip delay={350} closeDelay={80}>
          <Tooltip.Trigger>
            <Button variant="ghost" isIconOnly aria-label="Conversation details" onPress={onDetails}>
              <IconDetails width={17} height={17} aria-hidden />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Conversation details</Tooltip.Content>
        </Tooltip>
      ) : null}

      <Dropdown>
        <Button variant="ghost" isIconOnly aria-label="More conversation actions">
          <IconMore width={17} height={17} aria-hidden />
        </Button>
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label="More conversation actions"
            onAction={(key) => {
              if (key === "details") onDetails?.();
              if (key === "copy") copyPhone();
            }}
          >
            <Dropdown.Item id="details" textValue="Conversation details" isDisabled={!onDetails}>
              <IconDetails width={15} height={15} aria-hidden />
              <span>Conversation details</span>
            </Dropdown.Item>
            <Dropdown.Item id="copy" textValue="Copy phone number" isDisabled={!phone}>
              <IconCopy width={15} height={15} aria-hidden />
              <span>Copy phone number</span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </header>
  );
}
