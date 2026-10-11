/**
 * The app's zustand stores, put back as they were made after each drawn test: zustand's `create` stood in for (setup.ts
 * mocks the module with this), each store remembering its first state. Without it a menu left open, a question asked
 * or a project chosen in one test is still there in the next.
 */
import { vi } from "vitest";
import type * as Zustand from "zustand";

const resets = new Set<() => void>();

/** Every store back to the state it was made with. */
export function resetStores(): void {
  for (const reset of resets) reset();
}

/** The module `zustand` as the app sees it in these tests: the real one, its `create` keeping each store's first state. */
export async function zustandMock(): Promise<typeof Zustand> {
  const real = await vi.importActual<typeof Zustand>("zustand");
  const made = <T>(init: Zustand.StateCreator<T>) => {
    const store = real.create(init);
    const first = store.getInitialState();
    resets.add(() => store.setState(first, true));
    return store;
  };
  // create(init) and create<T>()(init) both, as the app uses either
  const create = (<T>(init?: Zustand.StateCreator<T>) => (init ? made(init) : made)) as typeof Zustand.create;
  return { ...real, create };
}
