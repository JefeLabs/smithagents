import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Broker data is pushed over the WebSocket, so background refetching would
 * re-request what a frame already delivered. Refetch-on-focus and refetch-on-
 * reconnect are off app-wide; the socket store is the update path.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 },
    },
  });
}

const appClient = makeQueryClient();

export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return <QueryClientProvider client={client ?? appClient}>{children}</QueryClientProvider>;
}
