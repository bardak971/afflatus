import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FileWhere } from "../../src/FileWhere";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A model file's place on disk (card #64): each whole path it is at, Show in folder on the computer Afflatus runs on (the
 * file named, never its path sent), Copy anywhere else, and its folder and name when ComfyUI runs on another machine.
 */

const OWN = "C:\\ComfyUI\\models\\loras\\soft.safetensors";
const A1111 = "D:\\a1111\\models\\Lora\\soft.safetensors";

describe("where a model file is", () => {
  it("lists each place, and Show in folder names the file and which place, not its path", async () => {
    fakeApi.on("GET /model-files/where", { known: true, reveal: true, places: [{ path: OWN, kind: "own" }, { path: A1111, kind: "other" }] });
    fakeApi.on("POST /model-files/reveal", { ok: true });
    const { user } = draw(<FileWhere folder="loras" file="soft.safetensors" machine="m2" />);
    expect(await screen.findByText(OWN)).toBeTruthy();
    expect(screen.getByText(A1111)).toBeTruthy();
    expect(fakeApi.calls("GET", "/model-files/where")[0]!.path).toBe("/model-files/where?folder=loras&file=soft.safetensors&machine=m2");
    const shows = screen.getAllByRole("button", { name: "Show in folder" });
    expect(shows).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
    await user.click(shows[1]!);
    await waitFor(() => expect(fakeApi.calls("POST", "/model-files/reveal").map((c) => c.body)).toEqual([{ folder: "loras", file: "soft.safetensors", at: 1, machine: "m2" }]));
  });

  it("offers Copy instead from another computer", async () => {
    fakeApi.on("GET /model-files/where", { known: true, reveal: false, places: [{ path: OWN, kind: "own" }] });
    const { user } = draw(<FileWhere folder="loras" file="soft.safetensors" />);
    await user.click(await screen.findByRole("button", { name: "Copy path" }));
    expect(await navigator.clipboard.readText()).toBe(OWN);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
  });

  it("says its folder and name when ComfyUI runs on another machine", async () => {
    fakeApi.on("GET /model-files/where", { known: false, reveal: false, places: [] });
    draw(<FileWhere folder="loras" file="wan/soft.safetensors" />);
    expect(await screen.findByText("loras/wan/soft.safetensors")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  });
});
