import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Gate } from "../../src/access/Gate";
import { api } from "../../src/api";
import { fakeApi, jsonAnswer } from "./fakeApi";
import { draw } from "./render";

/**
 * The Gate (access/Gate.tsx): a page opened already signed in whose session then ends (12 h idle, signed out from
 * another device) keeps the app drawn under the sign-in, with what was typed in it, rather than putting the sign-in in
 * its place.
 */

const session = { locked: true, session: true, stayDays: 30, telegram: false, telegramHeld: 0 };

/** A piece of the app with state of its own: what it holds is lost only if the app is unmounted. */
function Typed() {
  const [text, setText] = useState("");
  return <input aria-label="Prompt" value={text} onChange={(e) => setText(e.target.value)} />;
}

describe("the Gate", () => {
  it("lays the sign-in over the app when the session of a page opened signed in ends", async () => {
    let signedIn = true;
    fakeApi.on("GET /session", () => ({ ...session, signedIn }));
    fakeApi.on("GET /queue", () => new Response(JSON.stringify({ error: "Sign in again." }), { status: 401, headers: { "Content-Type": "application/json", "X-Afflatus-Sign-In": "1" } }));
    const { user } = draw(
      <Gate>
        <Typed />
      </Gate>,
    );
    const box = await screen.findByLabelText("Prompt");
    await user.type(box, "a lighthouse at dusk");

    // the session ends: the next request gets the lock's 401, and the session read again says signed out
    signedIn = false;
    await act(async () => {
      await api.queue().catch(() => undefined);
    });
    await waitFor(() => expect(fakeApi.calls("GET", "/session")).toHaveLength(2));
    await screen.findByRole("button", { name: /sign in/i });

    // the app is still there underneath, as it was
    expect((screen.getByLabelText("Prompt") as HTMLInputElement).value).toBe("a lighthouse at dusk");
  });

  it("draws only the sign-in on a page opened signed out", async () => {
    fakeApi.on("GET /session", () => jsonAnswer({ ...session, signedIn: false, session: false }));
    draw(
      <Gate>
        <Typed />
      </Gate>,
    );
    await screen.findByRole("button", { name: /sign in/i });
    expect(screen.queryByLabelText("Prompt")).toBeNull();
  });
});
