import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReferenceValue } from "@afflatus/core";
import { PictureField, ReferencesField } from "../../src/PictureField";
import { PasteHere, usePasteIntoLibrary } from "../../src/PasteHere";
import { Dialog } from "../../src/Dialog";
import { useSlotPaste } from "../../src/paste";
import { useBanners } from "../../src/store";
import { useTrackPaste } from "../../src/timeline/track/useTrackPaste";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** Ctrl+V on what has the focus, with `files` on the clipboard (and text when `types` says so), as Chrome hands it over. */
const paste = (files: File[], types: string[] = ["Files"]) =>
  fireEvent.paste(document.activeElement ?? document.body, {
    clipboardData: { files, items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), types, getData: () => "" },
  });

const png = (name = "zz-test.png") => new File(["png"], name, { type: "image/png" });
const wav = () => new File(["wav"], "zz-test.wav", { type: "audio/wav" });

/** Each upload answered as a new item named after its file, unless `found` names the item the library already holds. */
function uploads(found?: string) {
  let n = 0;
  fakeApi.on("POST /assets", ({ body }) => (found ? { id: found, kind: "image", name: "zz-test held", found: true } : { id: `zz-up-${++n}`, kind: (body as File).type.split("/")[0], name: (body as File).name }));
  return () => fakeApi.calls("POST", "/assets?");
}

const banner = (title: RegExp) => useBanners.getState().items.find((b) => title.test(b.title));

function Picture() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <PictureField label="Start image" optional={false} value={value} onChange={(v) => setValue(v ?? null)} />
      <output aria-label="value">{value ?? ""}</output>
      <input aria-label="Prompt" />
    </>
  );
}

function References() {
  const [value, setValue] = useState<ReferenceValue[]>([]);
  return (
    <>
      <ReferencesField label="Reference images" max={2} roles={["person"]} value={value} onChange={setValue} />
      <output aria-label="value">{value.map((v) => v.asset).join(",")}</output>
    </>
  );
}

const valueShown = () => screen.getByLabelText("value").textContent;

describe("Ctrl+V with pictures, videos or sounds on the clipboard", () => {
  it("typing in a text field: the browser's own paste, and a file pasted there is not uploaded", async () => {
    const sent = uploads();
    draw(<><PasteHere /><Picture /></>);
    screen.getByRole("textbox", { name: "Prompt" }).focus();
    // text and a file (a part of a page copied): the text goes in, as ever
    expect(paste([png()], ["Files", "text/plain"])).toBe(true);
    // a file alone: ignored there, no surprise upload
    paste([png()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent()).toHaveLength(0);
  });

  it("a picker open: the file is added to the library and picked, its search field holding the focus", async () => {
    const sent = uploads();
    const { user } = draw(<><PasteHere /><Picture /></>);
    await user.click(screen.getByRole("button", { name: /Choose an image, or drop one here/ }));
    const picker = await screen.findByRole("dialog", { name: "Start image" });
    expect(picker.contains(document.activeElement)).toBe(true);
    paste([png()]);
    await waitFor(() => expect(valueShown()).toBe("zz-up-1"));
    expect(sent()[0]!.path).toContain("same=use");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a picker open: a file of another kind is refused, saying what it takes", async () => {
    const sent = uploads();
    const { user } = draw(<><PasteHere /><Picture /></>);
    await user.click(screen.getByRole("button", { name: /Choose an image, or drop one here/ }));
    const picker = await screen.findByRole("dialog", { name: "Start image" });
    paste([wav()]);
    await waitFor(() => expect(within(picker).getAllByRole("alert").map((x) => x.textContent)).toContain("Start image takes images: zz-test.wav is an audio file."));
    expect(sent()).toHaveLength(0);
  });

  it("a refusal under a slot goes once a picture is picked in its picker", async () => {
    uploads();
    const { user } = draw(<><PasteHere /><Picture /></>);
    const slot = screen.getByRole("button", { name: /Choose an image, or drop one here/ });
    slot.focus();
    paste([wav()]);
    expect(screen.getByRole("alert").textContent).toBe("Start image takes images: zz-test.wav is an audio file.");
    await user.click(slot);
    await screen.findByRole("dialog", { name: "Start image" });
    paste([png()]);
    await waitFor(() => expect(valueShown()).toBe("zz-up-1"));
    expect(screen.queryByText(/takes images/)).toBeNull();
  });

  it("a media slot with the focus: as a drop on it", async () => {
    const sent = uploads();
    draw(<><PasteHere /><Picture /></>);
    screen.getByRole("button", { name: /Choose an image, or drop one here/ }).focus();
    paste([png()]);
    await waitFor(() => expect(valueShown()).toBe("zz-up-1"));
    expect(sent()).toHaveLength(1);
  });

  it("several files: a slot with room for two takes the first two, and says so", async () => {
    const sent = uploads();
    draw(<><PasteHere /><References /></>);
    screen.getByRole("button", { name: /Add a reference image/ }).focus();
    paste([png("zz-a.png"), png("zz-b.png"), png("zz-c.png")]);
    await waitFor(() => expect(valueShown()).toBe("zz-up-1,zz-up-2"));
    expect(sent().map((c) => c.path)).toEqual([expect.stringContaining("zz-a.png"), expect.stringContaining("zz-b.png")]);
    expect(screen.getByRole("alert").textContent).toBe("Reference images had room for 2: the first 2 of 3 were added.");
  });

  it("a file the library holds already: that item is used, not a copy", async () => {
    uploads("zz-held");
    draw(<><PasteHere /><Picture /></>);
    screen.getByRole("button", { name: /Choose an image, or drop one here/ }).focus();
    paste([png()]);
    await waitFor(() => expect(valueShown()).toBe("zz-held"));
  });

  it("the library shown: into the folder it shows", async () => {
    const sent = uploads();
    function Library() {
      usePasteIntoLibrary(true, "zz-folder", "zz-test Shoots");
      return null;
    }
    draw(<><PasteHere /><Library /></>);
    document.body.focus();
    paste([png()]);
    await waitFor(() => expect(banner(/^Pasted into zz-test Shoots$/)).toBeTruthy());
    expect(sent()[0]!.path).toMatch(/folder=zz-folder.*same=use/);
  });

  it("anywhere else: into the project's library, said in a banner that opens it", async () => {
    const sent = uploads();
    const { location } = draw(<PasteHere />, { at: "/queue" });
    document.body.focus();
    paste([png("image.png")]);
    await waitFor(() => expect(banner(/^Pasted into Inbox$/)).toBeTruthy());
    // a screenshot is named after the moment it was pasted
    expect(sent()[0]!.path).toMatch(/name=Pasted%20\d{4}-\d\d-\d\d%20/);
    expect(sent()[0]!.path).not.toContain("folder=");
    act(() => banner(/^Pasted into Inbox$/)!.act!());
    expect(location.history.at(-1)).toBe("/");
  });

  it("anywhere else, a file the library holds: said to be there already", async () => {
    uploads("zz-held");
    draw(<PasteHere />, { at: "/queue" });
    document.body.focus();
    paste([png()]);
    await waitFor(() => expect(banner(/^Already in Inbox$/)).toBeTruthy());
  });

  it("a modal on top that is no picker takes no paste: neither the library behind it nor the project's", async () => {
    const sent = uploads();
    function Library() {
      usePasteIntoLibrary(true, "zz-folder", "zz-test Shoots");
      return null;
    }
    draw(<><PasteHere /><Library /><Picture /><Dialog label="zz-test question" onClose={() => {}}><button type="button">OK</button></Dialog></>);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "zz-test question" }).contains(document.activeElement)).toBe(true));
    paste([png()]);
    // the slot under the modal, focused by a script, does not take it either
    screen.getByRole("button", { name: /Choose an image, or drop one here/ }).focus();
    paste([png()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent()).toHaveLength(0);
  });

  it("a picker under another modal is not asked: the one on top is", async () => {
    const sent = uploads();
    const { user } = draw(<><PasteHere /><Picture /></>);
    await user.click(screen.getByRole("button", { name: /Choose an image, or drop one here/ }));
    await screen.findByRole("dialog", { name: "Start image" });
    // a question asked over the picker (drawn after it, holding the focus)
    const { unmount } = draw(<Dialog label="zz-test question" onClose={() => {}} z="z-60"><button type="button">OK</button></Dialog>);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "zz-test question" }).contains(document.activeElement)).toBe(true));
    paste([png()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent()).toHaveLength(0);
    unmount();
  });

  it("a paste while the last one is still going in is said, not dropped without a word, and the word goes once it is in", async () => {
    let finish = () => {};
    fakeApi.on("POST /assets", ({ body }) => new Promise((r) => { finish = () => r({ id: "zz-up-1", kind: "image", name: (body as File).name }); }));
    draw(<><PasteHere /><Picture /></>);
    screen.getByRole("button", { name: /Choose an image, or drop one here/ }).focus();
    paste([png()]);
    await waitFor(() => expect(fakeApi.calls("POST", "/assets?")).toHaveLength(1));
    act(() => void paste([png("zz-second.png")]));
    expect(screen.getByRole("alert").textContent).toBe("Still adding the last one: paste again in a moment.");
    expect(fakeApi.calls("POST", "/assets?")).toHaveLength(1);
    act(() => finish());
    await waitFor(() => expect(valueShown()).toBe("zz-up-1"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a slot of its own make (the Prompt kit's): takes what it has room for and says the rest, one paste at a time", async () => {
    const took: string[][] = [];
    function Row({ busy }: { busy: boolean }) {
      const el = useRef<HTMLDivElement>(null);
      const said = useSlotPaste(true, { el: () => el.current, kind: "image", label: "zz-test Pictures", room: 2, busy, take: (files) => took.push(files.map((f) => f.name)) });
      return <div ref={el}><button type="button">Add</button>{said && <span role="alert">{said}</span>}</div>;
    }
    const { rerender } = draw(<><PasteHere /><Row busy={false} /></>);
    screen.getByRole("button", { name: "Add" }).focus();
    act(() => void paste([png("zz-a.png"), wav(), png("zz-b.png"), png("zz-c.png")]));
    expect(took).toEqual([["zz-a.png", "zz-b.png"]]);
    expect(screen.getByRole("alert").textContent).toBe("zz-test Pictures takes images: zz-test.wav is an audio file. zz-test Pictures had room for 2: the first 2 of 3 were added.");
    rerender(<><PasteHere /><Row busy /></>);
    act(() => void paste([png()]));
    expect(took).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("Still adding the last one: paste again in a moment.");
  });

  it("the library's banner Open does what the place says (the Media strip opens itself), and leaves the page as it is", async () => {
    uploads();
    const opened: string[] = [];
    function Strip() {
      usePasteIntoLibrary(true, null, "zz-test Shelf", (items) => opened.push(...items.map((a) => a.id)));
      return null;
    }
    const { location } = draw(<><PasteHere /><Strip /></>, { at: "/timelines/zz-test" });
    document.body.focus();
    paste([png()]);
    await waitFor(() => expect(banner(/^Pasted into zz-test Shelf$/)).toBeTruthy());
    const before = location.history.length;
    act(() => banner(/^Pasted into zz-test Shelf$/)!.act!());
    expect(opened).toEqual(["zz-up-1"]);
    expect(location.history).toHaveLength(before);
  });

  it("a timeline's drop cell with the focus: as a drop there, the kind it takes or refused", async () => {
    const placed: string[] = [];
    function Track() {
      const area = useRef<HTMLDivElement>(null);
      useTrackPaste({
        area,
        onUpload: async (file, reuse) => (reuse ? { id: `zz-${file.name}`, kind: file.type.split("/")[0]! } : null),
        onMusic: (asset) => placed.push(`music:${asset}`),
        onClipSound: (clip, asset) => placed.push(`${clip}:${asset}`),
      });
      return (
        <div ref={area}>
          <button type="button" data-paste="music">Music</button>
          <button type="button" data-paste="sound" data-paste-clip="zz-clip">Audio of clip 1</button>
          <button type="button">Clip 1</button>
        </div>
      );
    }
    const sent = uploads();
    draw(<><PasteHere /><Track /></>);
    screen.getByRole("button", { name: "Music" }).focus();
    paste([wav()]);
    screen.getByRole("button", { name: "Audio of clip 1" }).focus();
    paste([wav()]);
    await waitFor(() => expect(placed).toEqual(["music:zz-zz-test.wav", "zz-clip:zz-zz-test.wav"]));
    // a picture on the music: refused in a banner
    screen.getByRole("button", { name: "Music" }).focus();
    paste([png()]);
    expect(banner(/^Music takes audio files: zz-test.png is an image\.$/)).toBeTruthy();
    // the focus on a clip, not a drop cell: the track lets it go on to the project's library
    screen.getByRole("button", { name: "Clip 1" }).focus();
    paste([png()]);
    await waitFor(() => expect(sent()).toHaveLength(1));
  });
});
