import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui";

/**
 * What stands in for a screen that failed to draw, or whose chunk could not be loaded (a tab left open
 * across an upgrade): what went wrong, and a reload. Without it React unmounts the whole page and leaves
 * it blank. `whole`: the boundary around the app itself, which has nothing around it to fall back on.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; whole?: boolean }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // a chunk that is not there any more: the page is older than the server
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch|error loading/i.test(error.message);
    return (
      <div role="alert" className={this.props.whole ? "flex h-full items-center justify-center bg-ground p-8 text-ink" : "flex grow items-center justify-center p-8"}>
        <div className="flex max-w-lg flex-col items-start gap-3 rounded-2xl border border-line-strong bg-panel p-5">
          <h2 className="text-base font-semibold">{stale ? "Afflatus was updated" : "This screen failed"}</h2>
          <p className="m-0 text-ink-2">
            {stale ? "This page is older than the server: the part it asked for is no longer there. A reload gets the new one." : "Something went wrong while drawing it. A reload usually brings it back; what was saved is kept."}
          </p>
          <p className="m-0 font-mono text-xs break-all text-ink-3">{error.message}</p>
          <Button tone="primary" onClick={() => location.reload()}>Reload</Button>
        </div>
      </div>
    );
  }
}
