import { ChatConversation, ChatMessage as ChatMessageUI } from "@heroui-pro/react";
import { Markdown } from "@heroui-pro/react/markdown";
import { motion, useReducedMotion } from "motion/react";
import type { ChatMessage } from "../api/types";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  const reduceMotion = useReducedMotion();

  if (messages.length === 0) return null;

  // Same entrance every non-notice row gets, restored verbatim from the
  // pre-migration file: neither ChatConversation nor ChatMessage animate on
  // mount, so without this the transcript's only entrance motion is gone.
  const initial = reduceMotion ? false : { opacity: 0, y: 8 };
  const animate = { opacity: 1, y: 0 };
  const transition = { duration: 0.25, ease: "easeOut" as const };

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
              <motion.div key={m.id} initial={initial} animate={animate} transition={transition}>
                <ChatMessageUI.User>
                  <ChatMessageUI.Bubble>
                    <ChatMessageUI.Content>{m.text}</ChatMessageUI.Content>
                  </ChatMessageUI.Bubble>
                </ChatMessageUI.User>
              </motion.div>
            );
          }
          // Broker speech is speaker-prefixed ("Manuel: On it."). The prefix is
          // stripped BEFORE the body reaches Markdown — otherwise "Manuel:" is
          // parsed as body text and the speaker label disappears.
          const spoken = /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text);
          return (
            <motion.div key={m.id} initial={initial} animate={animate} transition={transition}>
              <ChatMessageUI.Assistant>
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
            </motion.div>
          );
        })}
      </ChatConversation.Content>
      <ChatConversation.ScrollAnchor />
    </ChatConversation>
  );
}
