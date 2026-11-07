import type { Message } from "@nexus/shared";
import { resolveAssistantLabel } from "../lib/assistants.js";
import { messageText } from "../services/execution-service.js";
import { messageTimestampLabel } from "../services/conversation-service.js";

export interface MessageBubbleProps {
  readonly message: Message;
}

/**
 * One persisted message.
 *
 * Only server data is rendered: `content` text parts, the author (derived from `role` plus
 * `assistantId`/`metadata.assistantKey`), the timestamp and the persisted `status`.
 * Nothing is synthesised locally, so a bubble on screen always exists in the backend.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const authorLabel = isUser
    ? "Você"
    : message.role === "assistant"
      ? (resolveAssistantLabel({
          assistantId: message.assistantId,
          metadata: message.metadata,
        }) ?? "Assistente")
      : "NEXUS CORE";

  const text = messageText(message);
  const timestamp = messageTimestampLabel(message);

  return (
    <li
      className={`bubble-row ${isUser ? "bubble-row-user" : "bubble-row-assistant"}`}
      data-testid={`message-${message.id}`}
      data-role={message.role}
    >
      <article className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>
        <header className="bubble-meta">
          <span className="bubble-author">{authorLabel}</span>
          {timestamp ? (
            <time className="bubble-time" dateTime={message.createdAt}>
              {timestamp}
            </time>
          ) : null}
        </header>
        <p className="bubble-text">{text.length > 0 ? text : "(mensagem sem texto)"}</p>
        {message.status !== "complete" ? (
          <p className={`bubble-state bubble-state-${message.status}`} role="status">
            {message.status === "pending"
              ? "Mensagem registrada, aguardando conclusão no servidor."
              : message.status === "failed"
                ? "O servidor registrou esta mensagem como falha."
                : "Esta mensagem foi cancelada no servidor."}
          </p>
        ) : null}
      </article>
    </li>
  );
}
