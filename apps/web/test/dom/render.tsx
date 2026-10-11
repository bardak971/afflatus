import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * A component drawn as the app draws it (main.tsx): under a query client of its own (fresh for each test, nothing retried,
 * so a 404 of the stand-in server is an error at once) and a router on an address of its own (not the page's). `user`
 * types, clicks and drops as a person does, through the events a browser sends.
 */
export function draw(ui: ReactElement, { at = "/" }: { at?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity }, mutations: { retry: false } } });
  const location = memoryLocation({ path: at, record: true });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>{children}</Router>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  return { ...render(ui, { wrapper: Wrapper }), user, client, location };
}
