import { Suspense } from "react";
import { create } from "zustand";
import { binFor } from "./keepFor";
import { lazyPart, loadConfirmDialog } from "./lazyParts";

/**
 * A question asked before something that cannot simply be undone from where it was done (a file taken
 * out of a folder of the disk). `ask` opens it over whatever is on screen and answers when it is closed.
 */
interface Question {
  title: string;
  text: string;
  /** What the button that goes ahead says. */
  yes: string;
  /** The plain explanation, behind a "?" by the title (the text says it in the app's own words). */
  help?: string;
}
/** A name or a line of text asked for: answered with what was typed, or null when closed. */
interface TextQuestion {
  title: string;
  value: string;
  placeholder?: string;
  /** What the button that goes ahead says. */
  yes: string;
}
/** A question with more than one way ahead (Resume while a GPU hunt holds the renders): answered with the choice's value, or null when closed. */
interface ChoiceQuestion {
  title: string;
  text: string;
  choices: Array<{ value: string; label: string }>;
  /** Places to look at first, listed under the text (the drafts that use an item): one answers null and goes there. */
  links?: Array<{ label: string; run(): void }>;
  /** What the button that does nothing says. */
  no: string;
}
/** `n`: which question it is, so that a second one asked in the place of the first starts from its own text. */
export type Open = { n: number } & (
  | (Question & { kind: "yes"; answer(ok: boolean): void })
  | (TextQuestion & { kind: "text"; answer(text: string | null): void })
  | (ChoiceQuestion & { kind: "choice"; answer(value: string | null): void })
);
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

export function askChoice<T extends string>(question: ChoiceQuestion & { choices: Array<{ value: T; label: string }> }): Promise<T | null> {
  return new Promise((done) => {
    closeOpen();
    useConfirm.setState({
      open: {
        ...question,
        n: ++asked,
        kind: "choice",
        answer: (value) => {
          useConfirm.setState({ open: null });
          done(value as T | null);
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

// the dialog itself is a chunk of its own (lazyParts.ts): not needed until a question is asked, so not in the first load
const Asked = lazyPart(loadConfirmDialog, (m) => m.ConfirmDialog);

export function ConfirmHost() {
  const open = useConfirm((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Asked key={open.n} open={open} />
    </Suspense>
  );
}

/** The question for files of a linked folder that are about to go to the bin. */
export const askAboutDisk = (files: Array<{ name: string; path: string | null }>) => {
  const onDisk = files.filter((f) => f.path);
  if (!onDisk.length) return Promise.resolve(true);
  const one = onDisk.length === 1;
  return ask({
    title: one ? "Remove this file from its folder on your disk?" : `Remove these ${onDisk.length} files from their folders on your disk?`,
    text: `${one ? onDisk[0]!.path : `${onDisk.slice(0, 4).map((f) => f.path).join("\n")}${onDisk.length > 4 ? `\nand ${onDisk.length - 4} more` : ""}`}\n\n${one ? "It is a file" : "They are files"} of a linked folder: sending ${one ? "it" : "them"} to the bin removes ${one ? "it" : "them"} from that folder on your disk. ${binFor() ? `For ${binFor()} ${one ? "it" : "they"} can be restored from the bin; after that ${one ? "it is" : "they are"} gone.` : `${one ? "It" : "They"} can be restored from the bin until it is emptied.`}`,
    yes: "Move to bin",
  });
};
