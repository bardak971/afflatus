import { useState } from "react";
import { ApiError } from "../api";
import { useNow } from "../hooks";
import { Button, ErrorNote } from "../ui";
import { CardSkeleton } from "./Card";

/** Past this long, a page being asked says who is slow. */
const SLOW_AFTER_MS = 3_000;

/** Skeleton cards while a page comes. */
export function CardSkeletons({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, i) => <CardSkeleton key={i} />)}</>;
}

/**
 * Who is slow to answer and for how long, once a page has been asked for more than 3 s: Civitai's API has slow spells (3.5
 * to 6.5 s a page on 2026-10-24), and a shimmer that says nothing more looks like Afflatus's own. Nothing before.
 */
export function SlowSaid({ site, waiting }: { site: string; waiting: boolean }) {
  // when this wait began: a new one (another search, the next page) starts the count again
  const [since, setSince] = useState<number | null>(null);
  if (waiting && since === null) setSince(Date.now());
  if (!waiting && since !== null) setSince(null);
  const now = useNow(1000, waiting);
  if (!waiting || since === null || now - since < SLOW_AFTER_MS) return null;
  return (
    <span role="status" className="flex items-center gap-2 px-1 text-xs text-ink-2">
      <span aria-hidden className="size-1.5 rounded-full bg-warn" />
      {site} is slow to answer · {Math.round((now - since) / 1000)} s
    </span>
  );
}

/**
 * A page that did not come: what failed, and Try again. When the site itself failed (it did not answer, or refused), what
 * still works is said too.
 */
export function SiteFailed({ error, other, onRetry }: { error: Error; other: string; onRetry(): void }) {
  const theSite = error instanceof ApiError && (error.status === 502 || error.status === 504);
  return (
    <ErrorNote>
      <span className="flex flex-col items-start gap-1.5">
        <span className="font-semibold">{error.message}</span>
        {theSite && <span className="text-xs">Your models (Yours) and {other} still work.</span>}
        <Button size="sm" onClick={onRetry}>Try again</Button>
      </span>
    </ErrorNote>
  );
}
