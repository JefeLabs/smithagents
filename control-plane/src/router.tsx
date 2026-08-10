import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import * as api from "./api/broker";
import type { ChatMessage, DocT, RosterAgent } from "./api/types";
import { agentSeeds } from "./data/agents";
import { useVoiceStatus } from "./hooks/useVoiceStatus";
import { Composer } from "./molecules/Composer";
import { Transcript } from "./molecules/Transcript";
import { BoardStage } from "./organisms/BoardStage";
import { DashboardsStage } from "./organisms/DashboardsStage";
import { DocumentStage } from "./organisms/DocumentStage";
import { MapStage } from "./organisms/MapStage";
import { VoiceStage } from "./organisms/VoiceStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";
import { useVoiceSettings } from "./queries/http";
import { useDocuments, useRoster, useTranscript } from "./queries/pushed";
import { useAudioStore } from "./stores/audioStore";
import { useSocketStore } from "./stores/socketStore";
import { useUiStore } from "./stores/uiStore";

// Stable empties: a fresh `[]` per render would churn every downstream effect
// keyed on the array's identity.
const NO_MESSAGES: ChatMessage[] = [];
const NO_ROSTER: RosterAgent[] = [];
const NO_DOCS: DocT[] = [];

/**
 * Route components are deliberately thin: they read broker state from the
 * query cache and the socket store and render the organisms with plain props.
 * No route loaders — data rides the WebSocket above the router, and mounting
 * it per-route would reconnect on every navigation.
 *
 * The mic/sound/STT controls come from `audioStore` and two ordinary queries.
 * Calling `useVoiceStatus`/`useVoiceSettings` here rather than receiving them
 * as props is safe precisely because they are queries: this route and anything
 * else asking share one cache entry, so an invalidation reaches both.
 */
function VoiceRoute() {
  const { data: messages = NO_MESSAGES } = useTranscript();
  const connected = useSocketStore((c) => c.connected);
  const voiceNotice = useUiStore((u) => u.voiceNotice);
  const showVoiceBlockedNotice = useUiStore((u) => u.showVoiceBlockedNotice);
  const micLive = useAudioStore((a) => a.micLive);
  // Registered by `usePushToTalk`, which owns the hardware at app scope — this
  // route asks for the toggle, it never holds the MediaStream.
  const toggleMic = useAudioStore((a) => a.toggleMic);
  const soundOn = useAudioStore((a) => a.soundOn);
  const toggleSound = useAudioStore((a) => a.toggleSound);
  const { voice } = useVoiceStatus();
  const { data: voicePrefs } = useVoiceSettings();
  // Hide the hero only on a CONFIRMED no-STT broker the user asked to hide.
  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;
  return (
    <VoiceStage
      micLive={micLive}
      onMicToggle={toggleMic}
      messages={messages}
      brokerConnected={connected}
      onSend={api.postUtterance}
      soundOn={soundOn}
      onSoundToggle={toggleSound}
      sttEnabled={voice.stt}
      onVoiceBlocked={showVoiceBlockedNotice}
      showMicHero={!hideMic}
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

function DashboardsRoute() {
  return <DashboardsStage />;
}

function DocRoute() {
  const { docId } = docRoute.useParams();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: messages = NO_MESSAGES } = useTranscript();
  const connected = useSocketStore((c) => c.connected);
  const doc = docs.find((d) => d.id === docId);
  // Unknown or deleted doc — the stage-routing convention: go home.
  if (!doc) return <Navigate to="/" replace />;
  return (
    <DocumentStage
      doc={doc}
      onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
      chat={
        <div className="document-stage__dock">
          <Transcript messages={messages} />
          <Composer onSend={api.postUtterance} disabled={!connected} />
        </div>
      }
    />
  );
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
const dashboardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboards",
  component: DashboardsRoute,
});
const docRoute = createRoute({ getParentRoute: () => rootRoute, path: "/doc/$docId", component: DocRoute });
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: "/work/$agentId", component: WorkRoute });

const routeTree = rootRoute.addChildren([indexRoute, boardRoute, mapRoute, dashboardsRoute, docRoute, workRoute]);

export function createAppRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
