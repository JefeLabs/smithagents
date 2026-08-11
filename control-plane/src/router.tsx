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
import { type ArtifactKind, familyForKind } from "./lib/artifactKinds";
import { ArtifactShelf } from "./molecules/ArtifactShelf";
import { Composer } from "./molecules/Composer";
import { Transcript } from "./molecules/Transcript";
import { BoardStage } from "./organisms/BoardStage";
import { DashboardsStage } from "./organisms/DashboardsStage";
import { MapStage } from "./organisms/MapStage";
import { VoiceStage } from "./organisms/VoiceStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";
import { useBlueprints, useVoiceSettings } from "./queries/http";
import { qk } from "./queries/keys";
import { useDocuments, useRoster, useSession, useTranscript } from "./queries/pushed";
import { useAudioStore } from "./stores/audioStore";
import { useSocketStore } from "./stores/socketStore";
import { useUiStore } from "./stores/uiStore";

// Stable empties: a fresh `[]` per render would churn every downstream effect
// keyed on the array's identity.
const NO_MESSAGES: ChatMessage[] = [];
const NO_ROSTER: RosterAgent[] = [];
const NO_DOCS: DocT[] = [];
const NO_BLUEPRINTS: BlueprintT[] = [];

/**
 * The composer kind row's click handler. Chat/Dashboards/Map navigate to their
 * stage; Documents/Diagrams create a fresh blueprint doc of the matching family
 * and open it — a document-family doc on the prose stage (`/doc`), a
 * diagram-family doc on the Mermaid canvas (`/diagram`). With no blueprint of
 * the asked family, it falls back to the first blueprint and routes by whatever
 * family that turns out to be.
 */
function makePickKind(
  navigate: ReturnType<typeof useNavigate>,
  qc: ReturnType<typeof useQueryClient>,
  blueprints: BlueprintT[],
): (kind: ArtifactKind) => void {
  return (kind) => {
    if (kind === "chat") return void navigate({ to: "/" });
    if (kind === "dashboards") return void navigate({ to: "/dashboards" });
    if (kind === "map") return void navigate({ to: "/map" });
    const family = familyForKind(kind); // "document" | "diagram"
    const bp = blueprints.find((b) => b.family === family) ?? blueprints[0];
    void api.postDocument(bp?.id ?? "spec", "").then((r) => {
      if (!r.doc) return;
      const created = r.doc;
      qc.setQueryData<DocT[]>(qk.documents, (prev: DocT[] | undefined) => [
        created,
        ...(prev ?? []).filter((d: DocT) => d.id !== created.id),
      ]);
      const fam = blueprints.find((b) => b.id === created.blueprintId)?.family;
      void navigate({
        to: fam === "diagram" ? "/diagram/$docId" : "/doc/$docId",
        params: { docId: created.id },
      });
    });
  };
}

// The document stage carries Tiptap/ProseMirror; a chat-only session should not
// download an editor it never opens. This is the app's first split chunk.
const DocumentStage = lazy(() => import("./organisms/DocumentStage").then((m) => ({ default: m.DocumentStage })));
// mermaid is heavy too; a session that never opens a diagram shouldn't ship it.
const DiagramStage = lazy(() => import("./organisms/DiagramStage").then((m) => ({ default: m.DiagramStage })));

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
  const { data: active } = useSession();
  const { data: rosterFrame } = useRoster();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Only the documents this session actually produced, in its own order.
  const shelfDocs = (active?.artifacts ?? [])
    .map((id) => docs.find((d) => d.id === id))
    .filter((d): d is DocT => Boolean(d));
  return (
    <VoiceStage
      micLive={micLive}
      onMicToggle={toggleMic}
      messages={messages}
      brokerConnected={connected}
      onSend={api.postUtterance}
      targets={rosterFrame?.agents ?? NO_ROSTER}
      soundOn={soundOn}
      onSoundToggle={toggleSound}
      sttEnabled={voice.stt}
      onVoiceBlocked={showVoiceBlockedNotice}
      showMicHero={!hideMic}
      voiceNotice={voiceNotice}
      onPolish={api.polishDraft}
      onPickKind={makePickKind(navigate, qc, blueprints)}
      activeKind="chat"
      shelf={
        <ArtifactShelf
          docs={shelfDocs}
          onOpen={(docId) => {
            // A diagram opens on its canvas, prose on the page — same family split
            // the kind row uses, so the shelf and the composer agree.
            const fam = blueprints.find((b) => b.id === docs.find((d) => d.id === docId)?.blueprintId)?.family;
            void navigate({
              to: fam === "diagram" ? "/diagram/$docId" : "/doc/$docId",
              params: { docId },
            });
          }}
        />
      }
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
  return (
    <Suspense fallback={null}>
      <DocumentStage
        doc={doc}
        blueprints={blueprints}
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
