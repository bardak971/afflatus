import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { RecipeInfo, Timeline } from "../../src/api";
import { SourcePanel } from "../../src/timeline/inspector/source";
import { useClipEdits } from "../../src/timeline/useClipEdits";
import { useTimelineMutations } from "../../src/timeline/useTimelineMutations";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** A model that makes a long video window by window (Motion transfer), with a Picture and a prompt: one whose source has a form of its own (a swap's has none). */
const model = {
  id: "zz-test.windows", family: "zz-test", title: "zz-test windows", output: "video", summary: "",
  traits: { fps: 16, frameGrid: 4, windows: { most: 81, least: 33, carried: 5 } },
  inputs: [
    { id: "picture", type: "image", role: "source", label: "Picture" },
    { id: "prompt", type: "prompt", label: "Prompt" },
    { id: "video", type: "clip", role: "source", label: "Driving video", window: { start: "start", seconds: "seconds" } },
    { id: "start", type: "number", label: "Start", default: 0 },
    { id: "seconds", type: "number", label: "Seconds", default: 5 },
  ],
} as unknown as RecipeInfo;

const timeline = {
  id: "zz-test-timeline", name: "zz-test timeline", clips: [], look: null, mood: null, folderId: null,
  source: { asset: "zz-test-video", video: { id: "zz-test-video", name: "zz-test.mp4" }, atMs: 0, fromMs: 0, toMs: 10_000, recipe: model.id, windowMs: 5000, inputs: { picture: "zz-test-picture", prompt: "as saved" }, withinMs: 0, clip: null },
} as unknown as Timeline;

const none = { data: undefined, isSuccess: false } as never;

/**
 * The timeline editor's part around the source lane's form: the clips' forms and their saving (useClipEdits), its
 * mutations, and the source panel, opened and closed as its lane is.
 */
function rig() {
  let m!: ReturnType<typeof useTimelineMutations>;
  let close!: () => void;
  function Editor() {
    const edits = useClipEdits({ timeline, clips: [], recipes: none, setup: none, settings: none, comfyOnline: true });
    m = useTimelineMutations(timeline.id, {
      timeline, clipsNow: { current: [] }, recipes: [model], firstRecipe: () => undefined, edits,
      on: { note: () => {}, select: () => {}, unpick: () => {}, writing: () => {}, open: () => {} },
    });
    const [open, setOpen] = useState(true);
    close = () => setOpen(false);
    return open ? (
      <SourcePanel
        timeline={timeline} place={null} recipes={[model]} clock={{ get: () => 0, set: () => {}, subscribe: () => () => {} }}
        onEdit={() => {}} onType={(inputs) => edits.typeSource(timeline.id, inputs)} typed={() => edits.sourceTyped(timeline.id)}
        onLook={() => {}} onMake={() => {}} making={false} made={{ left: 0, queued: 0 }} onRender={() => {}} rendering={false} onClose={close}
        picking={false} onPicking={() => {}}
      />
    ) : null;
  }
  const { unmount } = draw(<Editor />);
  return { m: () => m, close: () => close(), unmount };
}

/** The source's form saved, and its clips made, as the server is asked for them. */
function answerSource(saveStatus = 200): string[] {
  const came: string[] = [];
  fakeApi.on("PATCH /timelines/:id", ({ path, body }) => {
    came.push(`PATCH ${path} ${JSON.stringify(body)}`);
    return saveStatus === 200 ? timeline : new Response(JSON.stringify({ error: "zz-test refused" }), { status: saveStatus, headers: { "Content-Type": "application/json" } });
  });
  fakeApi.on("POST /timelines/:id/source/make", ({ path }) => (came.push(`POST ${path}`), { clips: [] }));
  return came;
}

const prompt = () => screen.getAllByRole("textbox").find((x) => (x as HTMLTextAreaElement).value === "as saved") as HTMLTextAreaElement;

describe("the source lane's form, drawn", () => {
  it("saves what was typed when its panel is closed at once", async () => {
    const came = answerSource();
    const { close } = rig();
    fireEvent.change(prompt(), { target: { value: "typed just now" } });
    close();
    await waitFor(() => expect(came).toEqual([`PATCH /timelines/zz-test-timeline ${JSON.stringify({ source: { inputs: { picture: "zz-test-picture", prompt: "typed just now" } } })}`]));
  });

  it("saves what was typed before its clips are made, which the server makes from the form it has", async () => {
    const came = answerSource();
    const { m } = rig();
    fireEvent.change(prompt(), { target: { value: "typed just now" } });
    m().makeSource.mutate();
    await waitFor(() => expect(m().makeSource.isSuccess).toBe(true));
    expect(came).toEqual([`PATCH /timelines/zz-test-timeline ${JSON.stringify({ source: { inputs: { picture: "zz-test-picture", prompt: "typed just now" } } })}`, "POST /timelines/zz-test-timeline/source/make"]);
  });

  it("makes nothing while what was typed could not be saved", async () => {
    const came = answerSource(500);
    const { m, unmount } = rig();
    fireEvent.change(prompt(), { target: { value: "typed just now" } });
    m().makeSource.mutate();
    await waitFor(() => expect(m().makeSource.isError).toBe(true));
    expect(came.filter((x) => x.startsWith("POST"))).toEqual([]);
    // the editor left: what was typed is still kept, and sent again
    unmount();
    await waitFor(() => expect(came.filter((x) => x.startsWith("PATCH"))).toHaveLength(2));
  });
});

describe("a swap's source, drawn (the owner, 2026-10-18: no source form, the clips' form is the one)", () => {
  /** A model with no Picture of its own, as the swap: its source shows the model, its stretch and Make only. */
  const swapLike = { ...model, id: "zz-test.swap", inputs: model.inputs.filter((i) => i.id !== "picture") } as RecipeInfo;
  const swapTimeline = { ...timeline, source: { ...timeline.source!, recipe: swapLike.id, inputs: {} } } as Timeline;

  it("has no form of its own, and its Make opens the first clip instead of rendering", () => {
    const made: Array<boolean | undefined> = [];
    draw(
      <SourcePanel
        timeline={swapTimeline} place={{ atMs: 0, lengthMs: 10_000, made: false, windows: [{ fromMs: 0, toMs: 5000 }, { fromMs: 4700, toMs: 10_000 }] as never, replaces: null }} recipes={[swapLike]}
        clock={{ get: () => 0, set: () => {}, subscribe: () => () => {} }}
        onEdit={() => {}} onType={() => {}} typed={() => undefined}
        onLook={() => {}} onMake={(andRender) => made.push(andRender)} making={false} made={{ left: 0, queued: 0 }} onRender={() => {}} rendering={false} onClose={() => {}}
        picking={false} onPicking={() => {}}
      />,
    );
    // no field of a form: the ± of Clip length is the source's own, as a recording's
    expect(screen.queryAllByRole("textbox").filter((x) => x.getAttribute("aria-label") !== "Window (± s of Clip length)")).toEqual([]);
    expect(screen.getByText(/settings are in the clips' form once they are made/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make 2 clips" }));
    expect(made).toEqual([false]);
  });

  it("says Render on the button when the source has a form, since its clips are rendered as they are made", () => {
    const made: Array<boolean | undefined> = [];
    draw(
      <SourcePanel
        timeline={timeline} place={{ atMs: 0, lengthMs: 10_000, made: false, windows: [{ fromMs: 0, toMs: 5000 }, { fromMs: 4700, toMs: 10_000 }] as never, replaces: null }} recipes={[model]}
        clock={{ get: () => 0, set: () => {}, subscribe: () => () => {} }}
        onEdit={() => {}} onType={() => {}} typed={() => undefined}
        onLook={() => {}} onMake={(andRender) => made.push(andRender)} making={false} made={{ left: 0, queued: 0 }} onRender={() => {}} rendering={false} onClose={() => {}}
        picking={false} onPicking={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Render 2 clips" }));
    expect(made).toEqual([true]);
  });
});
