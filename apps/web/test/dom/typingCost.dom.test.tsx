import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { Clip, FamilyInfo, RecipeInfo, Timeline } from "../../src/api";
import { useSearchKey } from "../../src/Keys";
import { Loras } from "../../src/fields/Loras";
import { useNewClock } from "../../src/timeline/clock";
import { keptSlots, layout } from "../../src/timeline/model";
import { Track } from "../../src/timeline/Track";
import { useClipEdits } from "../../src/timeline/useClipEdits";
import { useForecasts } from "../../src/timeline/useForecasts";
import { useMotionMarks } from "../../src/timeline/track/useMotionMarks";
import { queryKeys } from "../../src/queryKeys";
import { useFlip } from "../../src/useFlip";
import { draw } from "./render";

// what a key typed in a clip's form costs on a long timeline (perf review 2026-10-22, L-34): each clip's draws, its form
// and its checks worked out, the page's layout read, the LoRAs ranked
const counted = vi.hoisted(() => ({ clips: 0, loraFit: 0, settings: 0, pauses: 0 }));
vi.mock("../../src/form", async (real) => {
  const form = await real<typeof import("../../src/form")>();
  return { ...form, settingsOnly: (...a: Parameters<typeof form.settingsOnly>) => {
    counted.settings++;
    return form.settingsOnly(...a);
  } };
});
vi.mock("../../src/pauses", async (real) => {
  const pauses = await real<typeof import("../../src/pauses")>();
  return { ...pauses, pausesIn: (...a: Parameters<typeof pauses.pausesIn>) => {
    counted.pauses++;
    return pauses.pausesIn(...a);
  } };
});
vi.mock("../../src/timeline/track/nearJoin", async (real) => {
  const near = await real<typeof import("../../src/timeline/track/nearJoin")>();
  // read once by each clip at each of its draws
  return { ...near, useNearJoin: (...a: Parameters<typeof near.useNearJoin>) => {
    counted.clips++;
    return near.useNearJoin(...a);
  } };
});
vi.mock("@afflatus/core", async (real) => {
  const core = await real<typeof import("@afflatus/core")>();
  return { ...core, loraFit: (...a: Parameters<typeof core.loraFit>) => {
    counted.loraFit++;
    return core.loraFit(...a);
  } };
});

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }, { id: "steps", type: "number", label: "Steps", default: 8 }],
  traits: { sound: true },
} as unknown as RecipeInfo;
const clip = (id: string, at: number, inputs: Record<string, unknown> = { description: "zz-test" }) =>
  ({ id, kind: "video", recipe: video.id, joined: "cut", join: null, atMs: at, lengthMs: 0, inputs, music: null, take: null, takes: [], sound: "own", volume: 100, pictures: [] }) as unknown as Clip;
const timelineOf = (clips: Clip[]) => ({ id: "zz-test-typing", name: "zz-test typing", clips, durationMs: 0, music: null, source: null, recordings: [] }) as unknown as Timeline;
const forty = Array.from({ length: 40 }, (_, i) => clip(`c${i}`, i * 5000));

afterEach(() => vi.restoreAllMocks());

describe("a key typed in a clip's form (perf review 2026-10-22, L-34)", () => {
  it("lays the clips out again keeping every slot that did not change, and the list itself when none did", () => {
    const before = layout(forty, 40, [video]);
    const same = keptSlots(before, layout([...forty], 40, [video]));
    expect(same).toBe(before);
    const typed = forty.map((c, i) => (i === 7 ? { ...c, inputs: { description: "zz-test typed" } } : c));
    const after = keptSlots(before, layout(typed, 40, [video]));
    expect(after).not.toBe(before);
    expect(after.filter((s, i) => s !== before[i]).map((s) => s.clip.id)).toEqual(["c7"]);
    // a clip that got its length: it and every slot after it are laid anew, the ones before it kept
    const longer = forty.map((c, i) => (i === 7 ? { ...c, lengthMs: 9000 } : c));
    const moved = keptSlots(before, layout(longer, 40, [video]));
    expect(moved.map((s, i) => s === before[i])).toEqual(forty.map((_, i) => i < 7));
  });

  it("draws again the clip typed in and the one after it (its join), not the other clips of the track", () => {
    let type!: (text: string) => void;
    function Rig() {
      const clock = useNewClock();
      const [clips, setClips] = useState(forty);
      type = (text) => setClips((cs) => cs.map((c, i) => (i === 7 ? { ...c, inputs: { description: text } } : c)));
      return (
        <Track
          timeline={timelineOf(clips)} recipes={[video]} pps={40} onZoom={() => {}} selected="c7" musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
          onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
          onClipSound={() => {}} onMusic={() => {}} onTrim={() => {}} onNewClip={() => {}} range={null} onRange={() => {}}
        />
      );
    }
    draw(<Rig />);
    const before = counted.clips;
    for (const text of ["z", "zz", "zzz", "zzzz", "zzzzz"]) act(() => type(text));
    expect(counted.clips - before).toBeLessThanOrEqual(5 * 2);
  });

  it("works out again the whole form and the checks of the clip typed in only", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    // the reads as the editor holds them: the same objects from one drawing to the next
    const reads = {
      timeline: timelineOf(forty), clips: forty,
      recipes: { data: { recipes: [video] } } as never, setup: { data: undefined, isSuccess: false } as never, settings: { data: { items: [] } } as never,
      comfyOnline: true,
    };
    const { result, unmount } = renderHook(() => useClipEdits(reads), { wrapper });
    const [a, b] = [forty[7]!, forty[8]!];
    const formB = result.current.formOf(b);
    const readyB = result.current.ready(b);
    const formA = result.current.formOf(a);
    act(() => result.current.editInputs(a, { description: "zz-test typed" }));
    expect(result.current.formOf(b)).toBe(formB);
    expect(result.current.ready(b)).toBe(readyB);
    expect(result.current.formOf(a)).not.toBe(formA);
    expect(result.current.formOf(a)).toMatchObject({ description: "zz-test typed" });
    // left while the stand-in server answers: the form's save goes as the editor is left
    unmount();
  });

  it("works out again the settings asked a forecast for of the clip typed in only, and keeps the forecasts asked", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    // each clip's whole form, the same object while its form is the same (useClipEdits' formOf)
    const forms = new Map<string, Record<string, unknown>>(forty.map((c) => [c.id, { ...c.inputs, steps: 8 }]));
    const { rerender } = renderHook(({ formOf }) => useForecasts(forty, [video], formOf), { wrapper, initialProps: { formOf: (c: Clip) => forms.get(c.id) ?? null } });
    const before = counted.settings;
    // a prompt typed in clip 7, five keys: formOf is new at each, and clip 7's form with it
    for (const text of ["z", "zz", "zzz", "zzzz", "zzzzz"]) {
      forms.set("c7", { description: text, steps: 8 });
      rerender({ formOf: (c: Clip) => forms.get(c.id) ?? null });
    }
    expect(counted.settings - before).toBe(5);
    // the prompt is not asked about: one ask of the forecasts, the one of the first drawing
    expect(client.getQueryCache().findAll({ queryKey: ["forecasts"] })).toHaveLength(1);
    // a setting changed is asked about
    forms.set("c7", { description: "zzzzz", steps: 9 });
    rerender({ formOf: (c: Clip) => forms.get(c.id) ?? null });
    expect(client.getQueryCache().findAll({ queryKey: ["forecasts"] })).toHaveLength(2);
  });

  it("works out again the quiet moments and pauses of the clip whose slot changed only", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const made = forty.map((c, i) => ({ ...c, lengthMs: 5000, take: { id: `t${i}`, asset: { id: `zz-test-take-${i}` }, startMs: 0, endMs: 5000 } }) as unknown as Clip);
    const loud = Array.from({ length: 50 }, (_, k) => (k % 10 < 5 ? -10 : -50));
    for (const c of made) client.setQueryData(queryKeys.motion(c.take!.asset.id), { rate: 10, values: loud.map((d) => d + 60), sound: loud });
    const clock = { get: () => 0 } as never;
    const useMarks = (clips: Clip[], slots: ReturnType<typeof layout>) => useMotionMarks({ slots, clips, timeline: timelineOf(clips), playEnd: 200_000, pps: 40, clock });
    let slots = layout(made, 40, [video]);
    const start = counted.pauses;
    const { result, rerender } = renderHook(({ clips, slots }) => useMarks(clips, slots), { wrapper, initialProps: { clips: made, slots } });
    const before = counted.pauses;
    expect(before - start).toBe(made.length);
    const typed = made.map((c, i) => (i === 7 ? { ...c, inputs: { description: "zz-test typed" } } : c));
    slots = keptSlots(slots, layout(typed, 40, [video]));
    rerender({ clips: typed, slots });
    expect(counted.pauses - before).toBe(1);
    // the same marks as worked out afresh
    const fresh = renderHook(() => useMarks(typed, layout(typed, 40, [video])), { wrapper });
    expect(result.current.motion.map(({ curve, quiet, pauses }) => ({ curve, quiet, pauses }))).toEqual(fresh.result.current.motion.map(({ curve, quiet, pauses }) => ({ curve, quiet, pauses })));
    expect(result.current.motion.some((m) => m.pauses.length > 0)).toBe(true);
  });

  it("reads where the things of a reordered list are only when the order changes, not at each drawing", () => {
    const read = vi.fn(() => 0);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(read);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(read);
    function List({ order, text }: { order: string[]; text: string }) {
      const flip = useFlip(order);
      return <div>{order.map((k) => <span key={k} ref={flip(k)}>{k}{text}</span>)}</div>;
    }
    const { rerender } = render(<List order={["a", "b", "c"]} text="" />);
    read.mockClear();
    for (const text of ["z", "zz", "zzz"]) rerender(<List order={["a", "b", "c"]} text={text} />);
    expect(read).not.toHaveBeenCalled();
    // the order changed: where each was, before the change
    rerender(<List order={["c", "a", "b"]} text="zzz" />);
    expect(read).toHaveBeenCalled();
  });

  it("does not look for the open dialogs at every key typed: only \"/\" and \":\" are the search key's", () => {
    renderHook(() => useSearchKey());
    const all = vi.spyOn(document, "querySelectorAll");
    for (const key of ["a", "b", "Enter", " "]) fireEvent.keyDown(window, { key });
    expect(all).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "/" });
    expect(all).toHaveBeenCalled();
  });

  it("ranks the LoRAs once for a form drawn again on the next clip selected", () => {
    const family = { id: "zz-test", name: "Wan 2.2" } as unknown as FamilyInfo;
    const spec = { id: "loras", type: "loras", label: "LoRAs", max: 4 } as never;
    const files = Array.from({ length: 30 }, (_, i) => `zz-test/lora-${i}.safetensors`);
    const form = () => <Loras spec={spec} value={[]} options={files} family={family} model="wan2.2.safetensors" onChange={() => {}} />;
    const first = draw(form());
    const once = counted.loraFit;
    expect(once).toBeGreaterThanOrEqual(files.length);
    first.unmount();
    // the next clip's form: the same files, the same model, nothing read since
    draw(form());
    expect(counted.loraFit).toBe(once);
  });
});
