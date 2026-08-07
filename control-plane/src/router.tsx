import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import { useStage } from "./hooks/StageContext";
import { BoardStage } from "./organisms/BoardStage";
import { MapStage } from "./organisms/MapStage";
import { VoiceStage } from "./organisms/VoiceStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";

/**
 * Route components are deliberately thin: they read the broker slice from
 * StageContext (owned by HomePage, the root layout) and render the organisms
 * with plain props. No route loaders — data rides the WebSocket above the
 * router, and mounting it per-route would reconnect on every navigation.
 */
function VoiceRoute() {
  const s = useStage();
  return (
    <VoiceStage
      micLive={s.micLive}
      onMicToggle={s.onMicToggle}
      messages={s.messages}
      brokerConnected={s.brokerConnected}
      onSend={s.send}
      soundOn={s.soundOn}
      onSoundToggle={s.onSoundToggle}
      sttEnabled={s.sttEnabled}
      onVoiceBlocked={s.onVoiceBlocked}
      showMicHero={s.showMicHero}
      voiceNotice={s.voiceNotice}
    />
  );
}

function BoardRoute() {
  const s = useStage();
  return <BoardStage roster={s.roster} lastBoardUpdate={s.lastBoardUpdate} />;
}

function MapRoute() {
  const s = useStage();
  return <MapStage lastCapabilityUpdate={s.lastCapabilityUpdate} />;
}

function WorkRoute() {
  const s = useStage();
  const navigate = useNavigate();
  const { agentId } = workRoute.useParams();
  const agent = s.agents.find((a) => a.id === agentId);
  // Stale URL, removed agent, or the host (never inspectable) — go home.
  if (!agent || agent.kind === "host") return <Navigate to="/" replace />;
  return (
    <WorkStage
      name={agent.name}
      ring={agent.ring}
      onBack={() => void navigate({ to: "/" })}
      fetchActivity={s.activity}
      onWorkAction={s.workAction}
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
