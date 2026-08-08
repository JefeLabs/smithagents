import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import * as api from "./api/broker";
import type { ChatMessage, RosterAgent } from "./api/types";
import { agentSeeds } from "./data/agents";
import { useStage } from "./hooks/StageContext";
import { BoardStage } from "./organisms/BoardStage";
import { MapStage } from "./organisms/MapStage";
import { VoiceStage } from "./organisms/VoiceStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";
import { useRoster, useTranscript } from "./queries/pushed";
import { useSocketStore } from "./stores/socketStore";
import { useUiStore } from "./stores/uiStore";

// Stable empties: a fresh `[]` per render would churn every downstream effect
// keyed on the array's identity.
const NO_MESSAGES: ChatMessage[] = [];
const NO_ROSTER: RosterAgent[] = [];

/**
 * Route components are deliberately thin: they read broker state from the
 * query cache and the socket store and render the organisms with plain props.
 * No route loaders — data rides the WebSocket above the router, and mounting
 * it per-route would reconnect on every navigation.
 *
 * `useStage()` survives for the mic/sound/STT controls alone; see
 * `hooks/StageContext.tsx` for why they cannot be read here yet.
 */
function VoiceRoute() {
  const s = useStage();
  const { data: messages = NO_MESSAGES } = useTranscript();
  const connected = useSocketStore((c) => c.connected);
  const voiceNotice = useUiStore((u) => u.voiceNotice);
  return (
    <VoiceStage
      micLive={s.micLive}
      onMicToggle={s.onMicToggle}
      messages={messages}
      brokerConnected={connected}
      onSend={api.postUtterance}
      soundOn={s.soundOn}
      onSoundToggle={s.onSoundToggle}
      sttEnabled={s.sttEnabled}
      onVoiceBlocked={s.onVoiceBlocked}
      showMicHero={s.showMicHero}
      voiceNotice={voiceNotice}
    />
  );
}

function BoardRoute() {
  const { data: rosterFrame } = useRoster();
  return <BoardStage roster={rosterFrame?.agents ?? NO_ROSTER} />;
}

function MapRoute() {
  return <MapStage />;
}

function WorkRoute() {
  const navigate = useNavigate();
  const { agentId } = workRoute.useParams();
  const { data: rosterFrame } = useRoster();
  const agent = agentSeeds(rosterFrame?.agents ?? NO_ROSTER, rosterFrame?.identity ?? null).find(
    (a) => a.id === agentId,
  );
  // Stale URL, removed agent, or the host (never inspectable) — go home.
  if (!agent || agent.kind === "host") return <Navigate to="/" replace />;
  return (
    <WorkStage
      name={agent.name}
      ring={agent.ring}
      onBack={() => void navigate({ to: "/" })}
      fetchActivity={api.getActivity}
      onWorkAction={api.postWorkAction}
    />
  );
}

const rootRoute = createRootRoute({
  component: HomePage,
  notFoundComponent: () => <Navigate to="/" replace />,
});
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: VoiceRoute });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/board", component: BoardRoute });
const mapRoute = createRoute({ getParentRoute: () => rootRoute, path: "/map", component: MapRoute });
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: "/work/$agentId", component: WorkRoute });

const routeTree = rootRoute.addChildren([indexRoute, boardRoute, mapRoute, workRoute]);

export function createAppRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
