import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * A fresh QueryClient per test — retry off so failures surface immediately
 * instead of after backoff, gcTime 0 so nothing leaks between cases.
 * Returns the client so tests can seed the cache with setQueryData.
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & { client?: QueryClient },
): RenderResult & { client: QueryClient } {
  const client =
    options?.client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
    });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...render(ui, { wrapper, ...options }), client };
}
