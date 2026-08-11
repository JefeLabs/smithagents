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
import type { BlueprintT, DocT, GroupT, RosterAgent } from "./api/types";
import { agentSeeds } from "./data/agents";
import { savedMeta } from "./data/dashboards";
import { composeSpec, specToFence } from "./lib/dashboardSpec";
import { openDocByFamily } from "./lib/pickKind";
import { ArtifactShelf, shelfDocsFor } from "./molecules/ArtifactShelf";
import { PinButton } from "./molecules/PinButton";
import { BoardStage } from "./organisms/BoardStage";
import { DashboardsStage } from "./organisms/DashboardsStage";
import { MapStage } from "./organisms/MapStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";
import { useBlueprints } from "./queries/http";
import { useDocuments, useGroups, useRoster, useSession } from "./queries/pushed";
import { useUiStore } from "./stores/uiStore";

// Stable empties: a fresh `[]` per render would churn every downstream effect
// keyed on the array's identity.
const NO_ROSTER: RosterAgent[] = [];
const NO_DOCS: DocT[] = [];
const NO_BLUEPRINTS: BlueprintT[] = [];
const NO_GROUPS: GroupT[] = [];

// The document stage carries Tiptap/ProseMirror; a chat-only session should not
// download an editor it never opens. This is the app's first split chunk.
const DocumentStage = lazy(() => import("./organisms/DocumentStage").then((m) => ({ default: m.DocumentStage })));
// mermaid is heavy too; a session that never opens a diagram shouldn't ship it.
const DiagramStage = lazy(() => import("./organisms/DiagramStage").then((m) => ({ default: m.DiagramStage })));
// The dashboard doc canvas shares the presentation chunk with the launcher.
const DashboardDocStage = lazy(() =>
  import("./organisms/DashboardDocStage").then((m) => ({ default: m.DashboardDocStage })),
);

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

/** The shelf every kind canvas renders — the active session's docs, opened by family. */
function useShelf() {
  const navigate = useNavigate();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: session = null } = useSession();
  return (
    <ArtifactShelf
      docs={shelfDocsFor(session, docs)}
      onOpen={(id) => openDocByFamily(navigate, blueprints, docs, id)}
    />
  );
}

function MapRoute() {
  const shelf = useShelf();
  return <MapStage shelf={shelf} />;
}

function DashboardsRoute() {
  const navigate = useNavigate();
  const shelf = useShelf();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: groups = NO_GROUPS } = useGroups();
  // SAVED = dashboard docs pinned somewhere (spec 2026-08-11). A composed but
  // never-pinned dashboard lives on in its session's shelf, not here.
  const dashboardIds = new Set(blueprints.filter((b) => b.family === "dashboard").map((b) => b.id));
  const savedDocs = docs
    .filter((d) => dashboardIds.has(d.blueprintId) && (d.pins?.length ?? 0) > 0)
    .map((d) => ({ id: d.id, title: d.title, meta: savedMeta(d.pins, d.updatedAt) }));
  return (
    <DashboardsStage
      shelf={shelf}
      scopes={["all workspaces", ...groups.map((g) => g.name)]}
      savedDocs={savedDocs}
      onOpenSaved={(docId) => void navigate({ to: "/dashboard/$docId", params: { docId } })}
      onPresent={async (question, scope) => {
        // Birth on compose: the walk's product IS a document. The mock spec is
        // composed client-side for now; "make it real" swaps this for the
        // agent's spec without moving the doc machinery.
        const { doc } = await api.postDocument("dashboard", question);
        if (!doc) return; // broker down — stay on the ask screen
        await api.patchDocSection(doc.id, "question", `${question}\n\nscope: ${scope}`);
        await api.patchDocSection(doc.id, "spec", specToFence(composeSpec(question, scope)));
        void navigate({ to: "/dashboard/$docId", params: { docId: doc.id } });
      }}
    />
  );
}

function DocRoute() {
  const shelf = useShelf();
  const { docId } = docRoute.useParams();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: session = null } = useSession();
  const { data: groups = NO_GROUPS } = useGroups();
  const groupNames = groups.map((g) => g.name);
  const docTarget = useUiStore((s) => s.docTarget);
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
  // Document-only: the shell's dock-variant ChatDock provides chat on /doc.
  return (
    <Suspense fallback={null}>
      <DocumentStage
        doc={doc}
        blueprints={blueprints.filter((b) => b.family === docFamily)}
        shelf={shelf}
        pinControl={
          <PinButton
            pins={doc.pins}
            workspace={session?.workspace}
            groups={groupNames}
            onPin={(t) => api.pinDoc(doc.id, t)}
            onUnpin={(t) => api.unpinDoc(doc.id, t)}
          />
        }
        onAimSection={(sectionId, heading) => useUiStore.getState().setDocTarget({ docId: doc.id, sectionId, heading })}
        aimedSectionId={docTarget?.docId === doc.id ? docTarget.sectionId : undefined}
        onAcceptProposal={(proposalId) => api.acceptProposal(doc.id, proposalId)}
        onRejectProposal={(proposalId) => api.rejectProposal(doc.id, proposalId)}
        onChangeBlueprint={(blueprintId) => api.patchDocBlueprint(doc.id, blueprintId)}
        onRename={(title) => api.patchDocTitle(doc.id, title)}
        onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
      />
    </Suspense>
  );
}

function DiagramRoute() {
  const shelf = useShelf();
  const { docId } = diagramRoute.useParams();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS, status: bpStatus } = useBlueprints();
  const { data: session = null } = useSession();
  const { data: groups = NO_GROUPS } = useGroups();
  const groupNames = groups.map((g) => g.name);
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
        shelf={shelf}
        pinControl={
          <PinButton
            pins={doc.pins}
            workspace={session?.workspace}
            groups={groupNames}
            onPin={(t) => api.pinDoc(doc.id, t)}
            onUnpin={(t) => api.unpinDoc(doc.id, t)}
          />
        }
        onChangeBlueprint={(blueprintId) => api.patchDocBlueprint(doc.id, blueprintId)}
        onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
      />
    </Suspense>
  );
}

function DashboardDocRoute() {
  const shelf = useShelf();
  const { docId } = dashboardDocRoute.useParams();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS, status: bpStatus } = useBlueprints();
  const { data: session = null } = useSession();
  const { data: groups = NO_GROUPS } = useGroups();
  const groupNames = groups.map((g) => g.name);
  // Same both-resolved gate as DiagramRoute: family decides the canvas.
  if (status !== "success" || bpStatus !== "success") return null;
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return <Navigate to="/" replace />;
  const family = blueprints.find((b) => b.id === doc.blueprintId)?.family;
  if (family !== "dashboard") return <Navigate to="/doc/$docId" params={{ docId }} replace />;
  return (
    <Suspense fallback={null}>
      <DashboardDocStage
        doc={doc}
        shelf={shelf}
        pinControl={
          <PinButton
            pins={doc.pins}
            workspace={session?.workspace}
            groups={groupNames}
            onPin={(t) => api.pinDoc(doc.id, t)}
            onUnpin={(t) => api.unpinDoc(doc.id, t)}
          />
        }
        onRename={(title) => api.patchDocTitle(doc.id, title)}
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
const dashboardDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard/$docId",
  component: DashboardDocRoute,
});
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: "/work/$agentId", component: WorkRoute });

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  mapRoute,
  dashboardsRoute,
  docRoute,
  diagramRoute,
  dashboardDocRoute,
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
