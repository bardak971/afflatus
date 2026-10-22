import { useSyncExternalStore } from "react";

/**
 * The join the pointer is near on the video row (its clip's id; null: none), held outside React's state. As the Track's
 * state, each join the pointer crossed drew the whole track again, its lanes and their waves with it; read here by each
 * clip for its own join, only the clip whose "+" shows and the one whose "+" goes draw again.
 */
export interface NearJoin {
  get(): string | null;
  set(clip: string | null): void;
  subscribe(heard: () => void): () => void;
}

export function nearJoin(): NearJoin {
  let now: string | null = null;
  const heard = new Set<() => void>();
  return {
    get: () => now,
    set: (clip) => {
      if (clip === now) return;
      now = clip;
      for (const h of heard) h();
    },
    subscribe: (h) => {
      heard.add(h);
      return () => void heard.delete(h);
    },
  };
}

/** Whether the pointer is near the join before this clip. */
export const useNearJoin = (near: NearJoin, clip: string) => useSyncExternalStore(near.subscribe, () => near.get() === clip);
