import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ClipValue } from "@afflatus/core";
import { ClipField, PictureField } from "../../src/PictureField";
import { fakeApi, jsonAnswer, later } from "./fakeApi";
import { draw } from "./render";

/** A file dropped from the computer on `el`, as the browser hands it over. */
const dropFile = (el: Element, file: File) => fireEvent.drop(el, { dataTransfer: { files: [file], types: ["Files"], getData: () => "" } });

const png = () => new File(["png"], "zz-test.png", { type: "image/png" });
const mp4 = () => new File(["mp4"], "zz-test.mp4", { type: "video/mp4" });
const text = () => new File(["words"], "zz-test notes.txt", { type: "text/plain" });

/** The upload's request, held until the test answers it. */
function heldUpload() {
  const held = later<Response>();
  fakeApi.on("POST /assets", () => held.promise);
  return held;
}

function Picture() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <PictureField label="Start image" optional={false} value={value} onChange={(v) => setValue(v ?? null)} />
      <output aria-label="value">{value ?? ""}</output>
    </>
  );
}

function Clip() {
  const [value, setValue] = useState<ClipValue | null>(null);
  return (
    <>
      <ClipField label="Previous clip" role="previous" optional={false} value={value} onChange={(v) => setValue(v ?? null)} />
      <output aria-label="value">{value?.asset ?? ""}</output>
    </>
  );
}

const valueShown = () => screen.getByLabelText("value").textContent;

describe("a picture slot of a form, drawn", () => {
  it("says Adding… while a dropped picture is sent, then holds it", async () => {
    const held = heldUpload();
    draw(<Picture />);
    const slot = screen.getByRole("button", { name: /Choose an image, or drop one here/ });
    dropFile(slot, png());
    await waitFor(() => expect(slot.textContent).toContain("Adding…"));
    expect((slot as HTMLButtonElement).disabled).toBe(true);
    expect(fakeApi.calls("POST", "/assets?name=zz-test.png")).toHaveLength(1);
    held.answer(jsonAnswer({ id: "zz-test-uploaded", kind: "image" }));
    await waitFor(() => expect(valueShown()).toBe("zz-test-uploaded"));
    expect(screen.queryByText("Adding…")).toBeNull();
  });

  it("says why when the upload fails, and the slot can be used again", async () => {
    const held = heldUpload();
    draw(<Picture />);
    const slot = screen.getByRole("button", { name: /Choose an image, or drop one here/ });
    dropFile(slot, png());
    await waitFor(() => expect(slot.textContent).toContain("Adding…"));
    held.answer(jsonAnswer({ error: "zz-test: the disk is full" }, 507));
    expect((await screen.findByRole("alert")).textContent).toBe("zz-test: the disk is full");
    expect(slot.textContent).not.toContain("Adding…");
    expect((slot as HTMLButtonElement).disabled).toBe(false);
    expect(valueShown()).toBe("");
  });

  it("refuses a file of another kind in words, and sends nothing", async () => {
    draw(<Picture />);
    dropFile(screen.getByRole("button", { name: /Choose an image, or drop one here/ }), text());
    expect((await screen.findByRole("alert")).textContent).toBe("zz-test notes.txt is not an image.");
    expect(fakeApi.calls("POST", "/assets")).toHaveLength(0);
  });

  it("chosen from the computer through the picker, says Adding… there and why it failed", async () => {
    const held = heldUpload();
    const { user } = draw(<Picture />);
    await user.click(screen.getByRole("button", { name: /Choose an image, or drop one here/ }));
    const picker = await screen.findByRole("dialog", { name: "Start image" });
    const input = picker.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, png());
    await waitFor(() => expect(within(picker).getByRole("button", { name: /Adding…/ })).toBeTruthy());
    held.answer(jsonAnswer({ error: "zz-test: refused" }, 400));
    await waitFor(() => expect(within(picker).getAllByRole("alert").map((a) => a.textContent)).toContain("zz-test: refused"));
    expect(within(picker).getByRole("button", { name: /From your computer/ })).toBeTruthy();
  });
});

describe("a clip slot of a form, drawn", () => {
  it("says Adding… while a dropped video is sent, then holds it", async () => {
    const held = heldUpload();
    draw(<Clip />);
    const slot = screen.getByRole("button", { name: /Choose a video, or drop one here/ });
    dropFile(slot, mp4());
    await waitFor(() => expect(slot.textContent).toContain("Adding…"));
    held.answer(jsonAnswer({ id: "zz-test-video", kind: "video" }));
    await waitFor(() => expect(valueShown()).toBe("zz-test-video"));
  });

  it("says why when the upload fails", async () => {
    const held = heldUpload();
    draw(<Clip />);
    const slot = screen.getByRole("button", { name: /Choose a video, or drop one here/ });
    dropFile(slot, mp4());
    await waitFor(() => expect(slot.textContent).toContain("Adding…"));
    held.answer(jsonAnswer({ error: "zz-test: not a video ffmpeg can read" }, 400));
    expect((await screen.findByRole("alert")).textContent).toBe("zz-test: not a video ffmpeg can read");
    expect(slot.textContent).not.toContain("Adding…");
  });

  it("refuses a picture in words, and sends nothing", async () => {
    draw(<Clip />);
    dropFile(screen.getByRole("button", { name: /Choose a video, or drop one here/ }), png());
    expect((await screen.findByRole("alert")).textContent).toBe("zz-test.png is not a video.");
    expect(fakeApi.calls("POST", "/assets")).toHaveLength(0);
  });
});
