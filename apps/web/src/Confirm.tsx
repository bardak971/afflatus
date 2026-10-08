import { useState } from "react";
import { create } from "zustand";
import { Dialog } from "./Dialog";
import { Button, cx, fieldClass } from "./ui";

/**
 * A question asked before something that cannot simply be undone from where it was done (a file taken
 * out of a folder of the disk). `ask` opens it over whatever is on screen and answers when it is closed.
 */
interface Question {
  title: string;
  text: string;
  /** What the button that goes ahead says. */
  yes: string;
}
/** A name or a line of text asked for: answered with what was typed, or null when closed. */
interface TextQuestion {
  title: string;
  value: string;
  placeholder?: string;
  /** What the button that goes ahead says. */
  yes: string;
}
/** `n`: which question it is, so that a second one asked in the place of the first starts from its own text. */
type Open = { n: number } & ((Question & { kind: "yes"; answer(ok: boolean): void }) | (TextQuestion & { kind: "text"; answer(text: string | null): void }));
let asked = 0;
const useConfirm = create<{ open: Open | null }>(() => ({ open: null }));
const closeOpen = () => {
  const open = useConfirm.getState().open;
  if (open?.kind === "yes") open.answer(false);
  else open?.answer(null);
};

export function ask(question: Question): Promise<boolean> {
  return new Promise((done) => {
    // one question at a time: a second one takes the place of the first, which is answered no
    closeOpen();
    useConfirm.setState({
      open: {
        ...question,
        n: ++asked,
        kind: "yes",
        answer: (ok) => {
          useConfirm.setState({ open: null });
          done(ok);
        },
      },
    });
  });
}

export function askText(question: TextQuestion): Promise<string | null> {
  return new Promise((done) => {
    closeOpen();
    useConfirm.setState({
      open: {
        ...question,
        n: ++asked,
        kind: "text",
        answer: (text) => {
          useConfirm.setState({ open: null });
          done(text);
        },
      },
    });
  });
}

/** The text question: a box with what it holds now, Enter or the button answers, Escape closes with nothing. */
function TextAsk({ open }: { open: Extract<Open, { kind: "text" }> }) {
  const [text, setText] = useState(open.value);
  const send = () => open.answer(text.trim());
  return (
    <Dialog label={open.title} onClose={() => open.answer(null)} z="z-[95]" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
      <h2 className="text-base font-semibold">{open.title}</h2>
      <input
        autoFocus
        value={text}
        placeholder={open.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        className={cx(fieldClass, "w-full py-2")}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button tone="quiet" onClick={() => open.answer(null)}>Cancel</Button>
        <Button tone="primary" onClick={send}>{open.yes}</Button>
      </div>
    </Dialog>
  );
}

export function ConfirmHost() {
  const open = useConfirm((s) => s.open);
  if (!open) return null;
  if (open.kind === "text") return <TextAsk key={open.n} open={open} />;
  // over every other dialog: Escape answers the question and nothing else. The focus starts on Cancel:
  // an Enter pressed by habit does not go ahead with what cannot be undone
  return (
    <Dialog label={open.title} onClose={() => open.answer(false)} z="z-[95]" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
      <h2 className="text-base font-semibold">{open.title}</h2>
      <p className="m-0 whitespace-pre-line text-ink-2">{open.text}</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button tone="quiet" autoFocus onClick={() => open.answer(false)}>Cancel</Button>
        <Button tone="danger" onClick={() => open.answer(true)}>{open.yes}</Button>
      </div>
    </Dialog>
  );
}

/** The question for files of a linked folder that are about to go to the bin. */
export const askAboutDisk = (files: Array<{ name: string; path: string | null }>) => {
  const onDisk = files.filter((f) => f.path);
  if (!onDisk.length) return Promise.resolve(true);
  const one = onDisk.length === 1;
  return ask({
    title: one ? "Remove this file from its folder on your disk?" : `Remove these ${onDisk.length} files from their folders on your disk?`,
    text: `${one ? onDisk[0]!.path : `${onDisk.slice(0, 4).map((f) => f.path).join("\n")}${onDisk.length > 4 ? `\nand ${onDisk.length - 4} more` : ""}`}\n\n${one ? "It is a file" : "They are files"} of a linked folder: sending ${one ? "it" : "them"} to the bin removes ${one ? "it" : "them"} from that folder on your disk. For a week ${one ? "it" : "they"} can be restored from the bin; after that ${one ? "it is" : "they are"} gone.`,
    yes: "Move to bin",
  });
};
