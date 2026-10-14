import { lazy, Suspense } from "react";
import { useFind } from "./store";

const FindModels = lazy(() => import("../FindModels").then((m) => ({ default: m.FindModels })));

/** Find models over everything while a place has it open (openFindModels), loaded on first use. */
export function FindModelsHost() {
  const target = useFind((s) => s.target);
  if (!target) return null;
  return <Suspense fallback={null}><FindModels target={target} /></Suspense>;
}
