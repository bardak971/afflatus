import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { StorageCard } from "../../src/screens/settings/StorageCard";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** Settings › Storage's Backup row (review S-14): its count of files said as a count, "1 file" and not "1 files". */

describe("the Backup row", () => {
  it("says one file in the singular", async () => {
    fakeApi.on("GET /backup", { available: true, files: 1, bytes: 2048, database: true, withSecrets: false });
    draw(<StorageCard />);
    expect(await screen.findByText("1 file and the database")).toBeTruthy();
  });
});
