import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ConfirmHost } from "../../src/Confirm";
import { Card } from "../../src/findModels/Card";
import { Opened } from "../../src/findModels/Opened";
import { paidWords } from "../../src/findModels/paid";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * A version Civitai sells (card #163, Early Access for Buzz): said on its card and in the version picker, and asked before
 * it is picked, never held back.
 */

const file = (name: string) => ({ name, bytes: 1000, note: "", sha256: null, folder: "checkpoints", source: { kind: "civitai", version: 1, pick: name }, have: [] });
const card = {
  site: "civitai", id: "9", name: "Moody Mix", type: "Checkpoint", base: "Krea 2", creator: "maker", downloads: 10, likes: 1, updatedAt: null, thumb: null, page: "https://civitai.com/models/9",
  licence: { commercial: true, credit: false, derivatives: true }, fits: null, have: false, update: null, gated: false,
  versions: [
    { id: "1", name: "V9.1", base: "Krea 2", publishedAt: null, trainedWords: [], files: [file("moody_v91.safetensors")], paid: { until: null } },
    { id: "2", name: "V8.0", base: "Krea 2", publishedAt: null, trainedWords: [], files: [file("moody_v80.safetensors")] },
  ],
} as const;

describe("a paid Civitai version", () => {
  it("is said in a few words: paid for good, or Early Access until a day", () => {
    expect(paidWords({ until: null })).toBe("Paid");
    expect(paidWords({ until: "2099-11-05T09:00:00.000Z" })).toBe("Early Access · until 5 Nov 2099");
  });

  it("shows on its card, and in the version picker beside the free one", () => {
    fakeApi.on("GET /browse/folders", { folders: ["checkpoints"], comfy: true });
    draw(<><Card card={card as never} picked={false} onOpen={() => {}} onQuick={() => {}} /><Opened card={card as never} picked={new Set()} onPick={() => {}} onClose={() => {}} /></>);
    // the card's chip and the opened version's
    expect(screen.getAllByText("Paid")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /on its page/ }).getAttribute("href")).toBe("https://civitai.com/models/9?modelVersionId=1");
  });

  it("is asked before it is picked: No picks nothing, Pick anyway picks it", async () => {
    fakeApi.on("GET /browse/folders", { folders: ["checkpoints"], comfy: true });
    const onPick = vi.fn();
    const { user } = draw(<><Opened card={card as never} picked={new Set()} onPick={onPick} onClose={() => {}} /><ConfirmHost /></>);
    await user.click(screen.getByRole("button", { name: "Pick it" }));
    expect(await screen.findByText("This version is paid on Civitai")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onPick).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pick it" }));
    await user.click(await screen.findByRole("button", { name: "Pick anyway" }));
    expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ file: "moody_v91.safetensors" })]);
    // a free version: picked at once
    onPick.mockClear();
    await user.click(screen.getByRole("button", { name: "V8.0" }));
    await user.click(screen.getByRole("button", { name: "Pick it" }));
    expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ file: "moody_v80.safetensors" })]);
  });
});
