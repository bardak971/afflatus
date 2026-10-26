import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { SoundField } from "../../src/PictureField";
import { MicButton } from "../../src/mic/MicRecord";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/**
 * Recording a voice from the microphone into a sound slot (card #101): the 🎙 beside the slot, its dialog's states, the
 * take sent to the server as one to keep as a WAV, the trim proposed and kept or undone, the microphone picker, and the
 * page that cannot have the microphone. The browser's microphone is stood in for: getUserMedia, MediaRecorder and Web
 * Audio's AnalyserNode, its loudness set by the test (`mic.amp`) as a voice would set it.
 */

const mic = {
  /** The loudness the stand-in microphone hears now: 0 to 1. */
  amp: 0.5,
  devices: [{ kind: "audioinput", deviceId: "usb", label: "Headset (USB)" }] as Array<{ kind: string; deviceId: string; label: string }>,
  asked: [] as unknown[],
  refuse: null as string | null,
  track: null as (EventTarget & { stop(): void }) | null,
};

class FakeRecorder {
  static isTypeSupported = (t: string) => t.startsWith("audio/webm");
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["webm bytes"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeContext {
  createAnalyser() {
    return {
      fftSize: 256,
      getFloatTimeDomainData(buf: Float32Array) {
        for (let k = 0; k < buf.length; k++) buf[k] = (k % 2 ? 1 : -1) * mic.amp;
      },
    };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    return Promise.resolve();
  }
}

function stream() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  mic.track = track;
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

/** The page as a secure one (https, or this computer), or not. */
function page(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: secure ? {
      getUserMedia: async (c: unknown) => {
        mic.asked.push(c);
        if (mic.refuse) throw new DOMException("refused", mic.refuse);
        return stream();
      },
      enumerateDevices: async () => mic.devices,
      addEventListener() {},
      removeEventListener() {},
    } : undefined,
  });
}

beforeEach(() => {
  mic.amp = 0.5;
  mic.devices = [{ kind: "audioinput", deviceId: "usb", label: "Headset (USB)" }];
  mic.asked = [];
  mic.refuse = null;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeContext);
  URL.createObjectURL = () => "blob:take";
  URL.revokeObjectURL = () => {};
  page(true);
  fakeApi.on("POST /assets", { id: "zz-test-take", kind: "audio", name: "Recording · Voice sample", mime: "audio/wav", durationMs: 1500 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dialog = () => screen.getByRole("dialog", { name: /Record a voice/ });

/** Opens the slot's 🎙 and records a take: `quiet` ms of silence, `loud` of voice, `quiet` again, then Stop. */
async function recordTake(user: ReturnType<typeof draw>["user"], { quiet = 0, loud = 400 } = {}) {
  await user.click(screen.getByRole("button", { name: /from the microphone/ }));
  mic.amp = quiet ? 0.0005 : 0.5;
  await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
  await screen.findByRole("button", { name: /Stop/ });
  if (quiet) await sleep(quiet);
  mic.amp = 0.5;
  await sleep(loud);
  if (quiet) {
    mic.amp = 0.0005;
    await sleep(quiet);
  }
  await user.click(screen.getByRole("button", { name: /Stop/ }));
  await screen.findByRole("button", { name: /Use it/ });
}

const uploads = () => fakeApi.calls("POST", "/assets?");

describe("a sound slot's 🎙", () => {
  it("records a take and Use it fills the slot, sent to be kept as a WAV, named after the slot", async () => {
    const onChange = vi.fn();
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    expect(within(dialog()).getByText(/Press Record, then speak/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
    // recording: the waveform grows, the time runs, Stop and Cancel
    await screen.findByRole("button", { name: /Stop/ });
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll("[data-mic-wave=live] i").length).toBeGreaterThan(3));
    await waitFor(() => expect(document.querySelector("[data-mic-time]")!.textContent).not.toBe("0:00.0"));
    expect(screen.getByRole("meter", { name: "Level" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Stop/ }));
    // listen: the whole take, Listen, Retake, Trim, Save, Use it
    await screen.findByRole("button", { name: /Use it/ });
    expect(document.querySelector("[data-mic-wave=take]")).toBeTruthy();
    for (const name of [/^Listen/, /Retake/, /Trim the silence/, /Save to the library/]) expect(screen.getByRole("button", { name })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Use it/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("zz-test-take"));
    const [sent] = uploads();
    expect(sent!.path).toContain("take=wav");
    expect(decodeURIComponent(sent!.path)).toContain("name=Recording · Voice sample · ");
    // no trim kept: the whole take
    expect(sent!.path).not.toContain("from=");
    expect(screen.queryByRole("dialog", { name: /Record a voice/ })).toBeNull();
  });

  it("Save to the library keeps the take and fills nothing", async () => {
    const onChange = vi.fn();
    const { user } = draw(<SoundField label="Recording" optional={false} value={null} onChange={onChange} />);
    await recordTake(user);
    await user.click(screen.getByRole("button", { name: /Save to the library/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Record a voice/ })).toBeNull());
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]!.path).not.toContain("as=kit");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("proposes a trim of the silence at both ends, cut only once kept", async () => {
    const onChange = vi.fn();
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={onChange} />);
    await recordTake(user, { quiet: 500, loud: 500 });
    await user.click(screen.getByRole("button", { name: /Trim the silence/ }));
    expect(screen.getByText(/Cuts \d\.\d s of silence at the start and \d\.\d s at the end: \d\.\d s left\./)).toBeTruthy();
    const start = screen.getByRole("slider", { name: /trimmed take starts/ });
    const end = screen.getByRole("slider", { name: /trimmed take ends/ });
    expect(Number(start.getAttribute("aria-valuenow"))).toBeGreaterThan(0.2);
    expect(Number(end.getAttribute("aria-valuenow"))).toBeLessThan(Number(end.getAttribute("aria-valuemax")) - 0.2);
    // an edge moved with the keys, as a drag moves it
    const was = Number(start.getAttribute("aria-valuenow"));
    start.focus();
    await user.keyboard("{ArrowLeft}");
    expect(Number(start.getAttribute("aria-valuenow"))).toBeCloseTo(Math.max(0, was - 0.1), 2);
    // undone: nothing cut
    await user.click(screen.getByRole("button", { name: /Undo the trim/ }));
    expect(screen.queryByRole("slider")).toBeNull();
    // kept: the take is sent with it
    await user.click(screen.getByRole("button", { name: /Trim the silence/ }));
    const from = Number(screen.getByRole("slider", { name: /trimmed take starts/ }).getAttribute("aria-valuenow"));
    await user.click(screen.getByRole("button", { name: /Keep the trim/ }));
    expect(screen.getByText(/Trimmed: \d\.\d s kept/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Use it/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("zz-test-take"));
    expect(uploads()[0]!.path).toContain(`from=${from.toFixed(3)}`);
    expect(uploads()[0]!.path).toMatch(/&to=\d+\.\d{3}/);
  });

  it("proposes no trim for a take with no silence at its ends", async () => {
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await recordTake(user);
    expect((screen.getByRole("button", { name: /Trim the silence/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Retake drops the take and records another; Cancel drops the one being recorded", async () => {
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await recordTake(user);
    await user.click(screen.getByRole("button", { name: /Retake/ }));
    await screen.findByRole("button", { name: /Stop/ });
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(within(dialog()).getByRole("button", { name: /Record/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use it/ })).toBeNull();
    // the microphone is let go of
    expect(mic.track!.stop).toHaveBeenCalled();
    expect(uploads()).toHaveLength(0);
  });

  it("answers Space, Enter and Esc as its buttons say", async () => {
    const onChange = vi.fn();
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    await user.keyboard(" ");
    await screen.findByRole("button", { name: /Stop/ });
    // Esc while recording cancels the take, the dialog stays
    await user.keyboard("{Escape}");
    expect(dialog()).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: /Record/ })).toBeTruthy();
    await user.keyboard(" ");
    await screen.findByRole("button", { name: /Stop/ });
    await sleep(200);
    await user.keyboard(" ");
    await screen.findByRole("button", { name: /Use it/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("zz-test-take"));
  });

  it("says when it is too loud", async () => {
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    mic.amp = 1;
    await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
    expect(await screen.findByText("Too loud: it clips")).toBeTruthy();
  });

  it("says in words why the microphone was refused", async () => {
    mic.refuse = "NotAllowedError";
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
    expect(await screen.findByText(/refused the microphone\. Allow it with the mark next to the address/)).toBeTruthy();
    mic.refuse = "NotFoundError";
    await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
    expect(await screen.findByText(/No microphone was found/)).toBeTruthy();
  });

  it("says when the microphone goes away while recording", async () => {
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    await user.click(within(dialog()).getByRole("button", { name: /Record/ }));
    await screen.findByRole("button", { name: /Stop/ });
    mic.track!.dispatchEvent(new Event("ended"));
    expect(await screen.findByText(/The microphone went away while recording/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use it/ })).toBeNull();
  });

  it("goes with the Prompt kit's person when opened from the kit", async () => {
    const onTake = vi.fn();
    const { user } = draw(<MicButton slot="Voice sample" kit onTake={onTake} />);
    await recordTake(user);
    await user.click(screen.getByRole("button", { name: /Use it/ }));
    await waitFor(() => expect(onTake).toHaveBeenCalledWith("zz-test-take"));
    expect(uploads()[0]!.path).toContain("as=kit");
  });
});

describe("the microphone picker", () => {
  it("is not shown with one microphone", async () => {
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    await sleep(20);
    expect(within(dialog()).queryByRole("button", { name: /Microphone/ })).toBeNull();
    expect(within(dialog()).queryByText("Headset (USB)")).toBeNull();
  });

  it("lists them with several, and the one picked is asked for and kept in this browser", async () => {
    mic.devices = [{ kind: "audioinput", deviceId: "usb", label: "Headset (USB)" }, { kind: "audioinput", deviceId: "desk", label: "Desk mic" }, { kind: "videoinput", deviceId: "cam", label: "Camera" }];
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /from the microphone/ }));
    const picker = await within(dialog()).findByRole("button", { name: /Microphone/ });
    await user.click(picker);
    expect(screen.queryByRole("option", { name: /Camera/ })).toBeNull();
    await user.click(await screen.findByRole("option", { name: /Desk mic/ }));
    expect(localStorage.getItem("afflatus.mic")).toBe("desk");
    await user.click(within(dialog()).getByRole("button", { name: /^Record/ }));
    await screen.findByRole("button", { name: /Stop/ });
    expect(mic.asked.at(-1)).toEqual({ audio: { deviceId: { exact: "desk" } } });
  });
});

describe("a page that cannot have the microphone", () => {
  it("greys the 🎙, and a click says why and what to do", async () => {
    page(false);
    const { user } = draw(<SoundField label="Voice sample" optional value={null} onChange={() => {}} />);
    const button = screen.getByRole("button", { name: /from the microphone/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-tip")).toMatch(/needs this computer or https/);
    await user.click(button);
    expect(within(dialog()).getByText("The microphone can't be used from this address.")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: /Record/ })).toBeNull();
  });
});
