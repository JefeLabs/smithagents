import { Volume2, VolumeX } from "lucide-react";
import type { ChatMessage } from "../hooks/useBrokerChat";
import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";
import { Transcript } from "../molecules/Transcript";

interface VoiceStageProps {
  micLive: boolean;
  onMicToggle: () => void;
  messages: ChatMessage[];
  brokerConnected: boolean;
  onSend: (text: string) => void;
  soundOn: boolean;
  onSoundToggle: () => void;
}

export function VoiceStage({
  micLive,
  onMicToggle,
  messages,
  brokerConnected,
  onSend,
  soundOn,
  onSoundToggle,
}: VoiceStageProps) {
  return (
    <main>
      <h1 className="greeting">
        The mic is yours, <em>Edwin</em>
      </h1>
      <MicHero live={micLive} onToggle={onMicToggle} />
      <div className="stage-tools">
        <button
          type="button"
          className={soundOn ? "sound-toggle" : "sound-toggle off"}
          onClick={onSoundToggle}
          title={soundOn ? "Mute agent voices" : "Unmute agent voices"}
          aria-label={soundOn ? "Mute agent voices" : "Unmute agent voices"}
          aria-pressed={soundOn}
        >
          {soundOn ? <Volume2 strokeWidth={1.7} /> : <VolumeX strokeWidth={1.7} />}
        </button>
      </div>
      <Transcript messages={messages} />
      <Composer onSend={onSend} disabled={!brokerConnected} />
    </main>
  );
}
