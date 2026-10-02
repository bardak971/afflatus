import { useEffect } from "react";
import { create } from "zustand";
import { Button } from "./ui";

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
const useConfirm = create<{ open: (Question & { answer(ok: boolean): void }) | null }>(() => ({ open: null }));

export function ask(question: Question): Promise<boolean> {
  return new Promise((done) => {
    // one question at a time: a second one takes the place of the first, which is answered no
    useConfirm.getState().open?.answer(false);
    useConfirm.setState({
      open: {
        ...question,
        answer: (ok) => {
          useConfirm.setState({ open: null });
          done(ok);
        },
      },
    });
  });
}

export function ConfirmHost() {
  const open = useConfirm((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        open.answer(false);
      }
    };
    // before the screens' own keys: Escape answers the question and nothing else
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={open.title} className="fixed inset-0 z-[95] flex items-center justify-center bg-ground/85 p-8" onClick={() => open.answer(false)}>
      <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">{open.title}</h2>
        <p className="m-0 whitespace-pre-line text-ink-2">{open.text}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button tone="quiet" onClick={() => open.answer(false)}>Cancel</Button>
          <Button tone="danger" autoFocus onClick={() => open.answer(true)}>{open.yes}</Button>
        </div>
      </div>
    </div>
  );
}

/** The question for files of a linked folder that are about to go to the bin. */
export const askAboutDisk = (files: Array<{ name: string; path: string | null }>) => {
  const onDisk = files.filter((f) => f.path);
  if (!onDisk.length) return Promise.resolve(true);
  const one = onDisk.length === 1;
  return ask({
    title: one ? "Take this file out of its folder on your disk?" : `Take these ${onDisk.length} files out of their folders on your disk?`,
    text: `${one ? onDisk[0]!.path : `${onDisk.slice(0, 4).map((f) => f.path).join("\n")}${onDisk.length > 4 ? `\nand ${onDisk.length - 4} more` : ""}`}\n\n${one ? "It is a file" : "They are files"} of a linked folder: sending ${one ? "it" : "them"} to the bin removes ${one ? "it" : "them"} from that folder on your disk. For a week ${one ? "it" : "they"} can be put back from the bin; after that ${one ? "it is" : "they are"} gone.`,
    yes: one ? "Take it out" : "Take them out",
  });
};
