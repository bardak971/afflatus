import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import type { DesignerTurn } from "../../src/designer/types";
import { ClipDesigner } from "../../src/timeline/ClipDesigner";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

// the designer's panel stood in for: it shows the conversation it was given and says one more thing on a click
vi.mock("../../src/Designer", () => ({
  Designer: ({ turns, onTurns }: { turns: DesignerTurn[]; onTurns(t: DesignerTurn[]): void }) => (
    <div>
      <p data-testid="said">{turns.map((t) => t.content).join(",")}</p>
      <button type="button" onClick={() => onTurns([...turns, { role: "user", content: `T${turns.length + 1}` }])}>Say</button>
    </div>
  ),
}));
vi.mock("../../src/form", async (real) => ({ ...(await real<typeof import("../../src/form")>()), wholeForm: () => ({}) }));

const clip = { id: "zz-test-clip", recipe: "zz-test-recipe", joined: "cut" } as unknown as Clip;
const recipe = { id: "zz-test-recipe", inputs: [] } as unknown as RecipeInfo;

/** The timeline editor around the designer: its turns of this visit kept until it is left, as useTimelineEditor keeps them. */
function Editor() {
  const [open, setOpen] = useState(true);
  const [talks, setTalks] = useState<Record<string, DesignerTurn[]>>({});
  return (
    <>
      <button type="button" onClick={() => (setOpen(false), setTalks({}))}>Leave</button>
      <button type="button" onClick={() => setOpen(true)}>Come back</button>
      {open && (
        <ClipDesigner
          timeline={{ id: "zz-test-timeline" } as unknown as Timeline} clip={clip} clips={[clip]} recipes={[recipe]}
          setup={{ data: undefined } as never} settings={{ data: undefined } as never} inputsOf={() => ({})} sayOf={() => ""}
          turns={talks[clip.id]} onTurns={(t) => setTalks((all) => ({ ...all, [clip.id]: t }))}
          session={undefined} onSession={() => {}} onApply={() => {}} onClose={() => {}}
        />
      )}
    </>
  );
}

/** The server's copy of the clip's conversation: read by GET, replaced whole by each PATCH, as timelines.ts keeps it. */
function serverChat(chat: DesignerTurn[]) {
  const saved = { chat };
  fakeApi.on("GET /clips/:id/chat", () => ({ chat: saved.chat }));
  fakeApi.on("PATCH /clips/:id", ({ body }) => ((saved.chat = (body as { chat: DesignerTurn[] }).chat), { ok: true }));
  return saved;
}

describe("the clip designer's conversation, kept with the clip (card #267)", () => {
  it("opens on what the clip holds now when the editor is left and opened again, not on the copy read before", async () => {
    const saved = serverChat([{ role: "user", content: "T1" }]);
    const { user } = draw(<Editor />);
    await waitFor(() => expect(screen.getByTestId("said").textContent).toBe("T1"));
    await user.click(screen.getByRole("button", { name: "Say" }));
    await user.click(screen.getByRole("button", { name: "Say" }));
    await waitFor(() => expect(saved.chat.map((t) => t.content)).toEqual(["T1", "T2", "T3"]));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await user.click(screen.getByRole("button", { name: "Come back" }));
    await waitFor(() => expect(screen.getByTestId("said").textContent).toBe("T1,T2,T3"));
    await user.click(screen.getByRole("button", { name: "Say" }));
    await waitFor(() => expect(saved.chat.map((t) => t.content)).toEqual(["T1", "T2", "T3", "T4"]));
  });

  it("does not open on an empty conversation when the clip's could not be read: it says so, and opens once read again", async () => {
    const saved = serverChat([{ role: "user", content: "T1" }]);
    fakeApi.on("GET /clips/:id/chat", () => jsonAnswer({ error: "the server is away" }, 500));
    const { user } = draw(<Editor />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Say" })).toBeNull();
    expect(fakeApi.calls("PATCH", "/clips/")).toEqual([]);
    fakeApi.on("GET /clips/:id/chat", () => ({ chat: saved.chat }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("said").textContent).toBe("T1"));
  });
});
