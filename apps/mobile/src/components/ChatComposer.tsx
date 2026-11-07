import { useEffect, useRef, type KeyboardEvent } from "react";

export interface ChatComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  /** Blocks sending while a message is being processed (duplicate-send lock). */
  readonly disabled: boolean;
  /** Why sending is blocked; shown under the input for clarity. */
  readonly disabledReason?: string;
  readonly placeholder?: string;
}

/**
 * Multiline composer with an explicit send button.
 *
 * Keyboard behaviour (Android-safe):
 * - Enter inserts a newline (multiline text stays multiline);
 * - Ctrl+Enter / Meta+Enter sends, matching desktop conventions without stealing Enter from
 *   the on-screen keyboard, where Enter is the user's line break;
 * - `inputMode="text"` and `enterKeyHint="enter"` keep the IME predictable on Android.
 *
 * The button is disabled while a send is in flight, which is the primary duplicate-send guard;
 * the screen also ignores a second submit, so a double tap cannot produce two requests.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  disabledReason,
  placeholder = "Escreva uma mensagem…",
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = !disabled && value.trim().length > 0;

  // Grow with the content, bounded by CSS `max-height`; reset when emptied.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label className="sr-only" htmlFor="chat-message-input">
        Mensagem
      </label>
      <textarea
        id="chat-message-input"
        ref={textareaRef}
        className="composer-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        enterKeyHint="enter"
        autoComplete="off"
        disabled={disabled}
        aria-describedby={disabled && disabledReason ? "chat-composer-status" : undefined}
      />
      <button
        type="submit"
        className="button button-primary composer-send"
        disabled={!canSend}
        aria-label="Enviar mensagem"
      >
        Enviar
      </button>
      {disabled && disabledReason ? (
        <p id="chat-composer-status" className="composer-hint" role="status">
          {disabledReason}
        </p>
      ) : null}
    </form>
  );
}
