import { useEffect, useRef } from "react";
import type { ChatMessage } from "../hooks/useBrokerChat";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length]);

  if (messages.length === 0) return null;

  return (
    <div className="transcript" role="log" aria-label="Conversation transcript">
      {messages.map((m) => {
        // Broker speech is speaker-prefixed ("Manuel: On it.") — render the name as a label.
        const spoken = m.role === "broker" ? /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text) : null;
        return (
          <div key={m.id} className={`msg ${m.role}`}>
            {spoken ? (
              <>
                <b className="speaker">{spoken[1]}</b> {spoken[2]}
              </>
            ) : (
              m.text
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
