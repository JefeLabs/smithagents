import { ChatConversation, ChatMessage as ChatMessageUI } from "@heroui-pro/react";
import { Markdown } from "@heroui-pro/react/markdown";
import type { ChatMessage } from "../api/types";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  if (messages.length === 0) return null;

  return (
    <ChatConversation className="transcript" role="log" aria-label="Conversation transcript">
      <ChatConversation.Content>
        {messages.map((m) => {
          if (m.role === "notice") {
            return (
              <p key={m.id} className="transcript__notice" role="status">
                {m.text}
              </p>
            );
          }
          if (m.role === "user") {
            return (
              <ChatMessageUI.User key={m.id}>
                <ChatMessageUI.Bubble>
                  <ChatMessageUI.Content>{m.text}</ChatMessageUI.Content>
                </ChatMessageUI.Bubble>
              </ChatMessageUI.User>
            );
          }
          // Broker speech is speaker-prefixed ("Manuel: On it."). The prefix is
          // stripped BEFORE the body reaches Markdown — otherwise "Manuel:" is
          // parsed as body text and the speaker label disappears.
          const spoken = /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text);
          return (
            <ChatMessageUI.Assistant key={m.id}>
              <ChatMessageUI.Body>
                <ChatMessageUI.Content>
                  {spoken ? (
                    <>
                      <b className="speaker">{spoken[1]}</b> <Markdown>{spoken[2]}</Markdown>
                    </>
                  ) : (
                    <Markdown>{m.text}</Markdown>
                  )}
                </ChatMessageUI.Content>
              </ChatMessageUI.Body>
            </ChatMessageUI.Assistant>
          );
        })}
      </ChatConversation.Content>
      <ChatConversation.ScrollAnchor />
    </ChatConversation>
  );
}
