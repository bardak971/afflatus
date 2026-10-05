import { create } from "zustand";
import { Dialog } from "./Dialog";
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
  if (!open) return null;
  // over every other dialog: Escape answers the question and nothing else
  return (
    <Dialog label={open.title} onClose={() => open.answer(false)} z="z-[95]" className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-line-strong bg-panel p-5">
      <h2 className="text-base font-semibold">{open.title}</h2>
      <p className="m-0 whitespace-pre-line text-ink-2">{open.text}</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button tone="quiet" onClick={() => open.answer(false)}>Cancel</Button>
        <Button tone="danger" autoFocus onClick={() => open.answer(true)}>{open.yes}</Button>
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
