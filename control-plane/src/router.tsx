import { useQueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import * as api from "./api/broker";
import type { BlueprintT, ChatMessage, DocT, RosterAgent } from "./api/types";
import { agentSeeds } from "./data/agents";
import { useVoiceStatus } from "./hooks/useVoiceStatus";
import { makePickKind } from "./lib/pickKind";
import { Composer } from "./molecules/Composer";
import { Transcript } from "./molecules/Transcript";
import { BoardStage } from "./organisms/BoardStage";
import { DashboardsStage } from "./organisms/DashboardsStage";
import { MapStage } from "./organisms/MapStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";
import { useBlueprints, useVoiceSettings } from "./queries/http";
import { useDocuments, useRoster, useTranscript } from "./queries/pushed";
import { useAudioStore } from "./stores/audioStore";
import { useSocketStore } from "./stores/socketStore";
import { useUiStore } from "./stores/uiStore";

// Stable empties: a fresh `[]` per render would churn every downstream effect
// keyed on the array's identity.
const NO_MESSAGES: ChatMessage[] = [];
const NO_ROSTER: RosterAgent[] = [];
const NO_DOCS: DocT[] = [];
const NO_BLUEPRINTS: BlueprintT[] = [];

// The document stage carries Tiptap/ProseMirror; a chat-only session should not
// download an editor it never opens. This is the app's first split chunk.
const DocumentStage = lazy(() => import("./organisms/DocumentStage").then((m) => ({ default: m.DocumentStage })));
// mermaid is heavy too; a session that never opens a diagram shouldn't ship it.
const DiagramStage = lazy(() => import("./organisms/DiagramStage").then((m) => ({ default: m.DiagramStage })));

/**
 * Route components are deliberately thin: they read broker state from the
 * query cache and the socket store and render the organisms with plain props.
 * No route loaders — data rides the WebSocket above the router, and mounting
 * it per-route would reconnect on every navigation. The chat box is NOT among
 * these props anymore: one persistent ChatDock lives in the shell (HomePage)
 * and repositions by route, so no stage carries its own composer.
 */
// `/` renders nothing of its own: the persistent ChatDock (mounted in the shell,
// HomePage) covers the home surface in its `full` variant over the dot-grid. The
// route stays registered so navigations to "/" resolve; it just has no stage.
function VoiceRoute() {
  return null;
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: rosterFrame } = useRoster();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: messages = NO_MESSAGES } = useTranscript();
  const connected = useSocketStore((c) => c.connected);
  // The docked chat IS this session's conversation, so it carries the same voice
  // controls the voice stage does. usePushToTalk owns the hardware at app scope
  // (HomePage) and publishes through audioStore, so this route only asks for the
  // toggles — it never holds a MediaStream of its own.
  const micLive = useAudioStore((a) => a.micLive);
  const toggleMic = useAudioStore((a) => a.toggleMic);
  const soundOn = useAudioStore((a) => a.soundOn);
  const toggleSound = useAudioStore((a) => a.toggleSound);
  const showVoiceBlockedNotice = useUiStore((u) => u.showVoiceBlockedNotice);
  const { voice } = useVoiceStatus();
  const { data: voicePrefs } = useVoiceSettings();
  // Same hide-inactive rule as the voice stage: only a CONFIRMED no-STT broker
  // the user asked to hide drops the mic entirely.
  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;
  // Cold-WS race: on a hard reload of /doc/:id the documents frame hasn't
  // landed yet, so the query is still `pending` — that is not "no such doc",
  // it's "don't know yet". Only a RESOLVED query missing the doc means
  // unknown or deleted (same `status`-over-`data` precedent as useSessionKnown).
  if (status !== "success") return null;
  const doc = docs.find((d) => d.id === docId);
  // Unknown or deleted doc — the stage-routing convention: go home.
  if (!doc) return <Navigate to="/" replace />;
  // The type switch re-casts a doc under a sibling blueprint, which only makes
  // sense within a family — you can't turn a prose page into an ER diagram. So
  // the switch sees only same-family blueprints. (DiagramRoute filters likewise.)
  const docFamily = blueprints.find((b) => b.id === doc.blueprintId)?.family ?? "document";
  return (
    <Suspense fallback={null}>
      <DocumentStage
        doc={doc}
        blueprints={blueprints.filter((b) => b.family === docFamily)}
        onChangeBlueprint={(blueprintId) => api.patchDocBlueprint(doc.id, blueprintId)}
        onRename={(title) => api.patchDocTitle(doc.id, title)}
        onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
        chat={
          <div className="document-stage__dock">
            <Transcript messages={messages} />
            <Composer
              onSend={api.postUtterance}
              targets={rosterFrame?.agents ?? NO_ROSTER}
              disabled={!connected}
              onPolish={api.polishDraft}
              micLive={micLive}
              onMicToggle={hideMic ? undefined : toggleMic}
              soundOn={soundOn}
              onSoundToggle={toggleSound}
              sttEnabled={voice.stt}
              onVoiceBlocked={showVoiceBlockedNotice}
              onPickKind={makePickKind(navigate, qc, blueprints)}
              activeKind="documents"
            />
          </div>
        }
      />
    </Suspense>
  );
}

function DiagramRoute() {
  const { docId } = diagramRoute.useParams();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS, status: bpStatus } = useBlueprints();
  // Diagrams and prose share the /doc store; the blueprint family decides which
  // canvas shows a doc. So wait for BOTH the doc and the blueprints that type it
  // before routing — a pending blueprints query is "don't know the family yet",
  // not "it's prose", and redirecting on that guess would flap on a cold reload.
  if (status !== "success" || bpStatus !== "success") return null;
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return <Navigate to="/" replace />;
  // Only diagrams live here; a prose doc reached via /diagram goes to /doc.
  const family = blueprints.find((b) => b.id === doc.blueprintId)?.family;
  if (family !== "diagram") return <Navigate to="/doc/$docId" params={{ docId }} replace />;
  return (
    <Suspense fallback={null}>
      <DiagramStage
        doc={doc}
        blueprints={blueprints.filter((b) => b.family === "diagram")}
        onChangeBlueprint={(blueprintId) => api.patchDocBlueprint(doc.id, blueprintId)}
        onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
      />
    </Suspense>
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
const diagramRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/diagram/$docId",
  component: DiagramRoute,
});
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: "/work/$agentId", component: WorkRoute });

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  mapRoute,
  dashboardsRoute,
  docRoute,
  diagramRoute,
  workRoute,
]);

export function createAppRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
