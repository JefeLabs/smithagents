import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";

interface VoiceStageProps {
  micLive: boolean;
  onMicToggle: () => void;
}

export function VoiceStage({ micLive, onMicToggle }: VoiceStageProps) {
  return (
    <main>
      <h1 className="greeting">
        The mic is yours, <em>Edwin</em>
      </h1>
      <MicHero live={micLive} onToggle={onMicToggle} />
      <Composer />
    </main>
  );
}
