import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./queryKeys";
import { usd } from "./format";

export type CapKey = "day" | "month";
export type Caps = Record<CapKey, number>;

/**
 * The spending caps' saves, for Settings › Rented GPUs and the first launch alike (a cap is money). Each edit is sent after
 * the ones before it, its body built when it is sent from the caps as the edits before it left them: a second edit within
 * one round trip never brings the first one's old value back. A save that failed takes its cap back to the caps as saved
 * for the edits after it (unless one of them edits that same cap), is said under the boxes until that same cap saves (a
 * save of the other one says nothing of it), and remounts its box (`resets`, as a `key`) so that it shows the cap as saved,
 * not the amount typed, which is not in force.
 */
export function useCapsSave(caps: Caps) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (rentCaps: Caps) => api.saveSettings({ rentCaps }),
    onSuccess: (saved) => {
      client.setQueryData(queryKeys.settings(), saved);
      void client.invalidateQueries({ queryKey: queryKeys.rentedSpending() });
    },
  });
  // the caps as the edits made so far leave them (null: none under way, the caps as saved are read), the caps as the
  // server last saved them, each cap's last edit, and the saves under way
  const wanted = useRef<Caps | null>(null);
  const saved = useRef<Caps>(caps);
  const lastEdit = useRef<Record<CapKey, number>>({ day: 0, month: 0 });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const [notSaved, setNotSaved] = useState<Partial<Record<CapKey, string>>>({});
  const [resets, setResets] = useState<Record<CapKey, number>>({ day: 0, month: 0 });
  const change = (key: CapKey, value: number) => {
    if (!wanted.current) {
      wanted.current = { ...caps };
      saved.current = { ...caps };
    }
    wanted.current[key] = value;
    const edit = ++lastEdit.current[key];
    pending.current += 1;
    queue.current = queue.current
      .then(() => save.mutateAsync({ ...wanted.current! }))
      .then(
        (answer) => {
          saved.current = { ...(answer.rentCaps ?? saved.current) };
          setNotSaved(({ [key]: _was, ...rest }) => rest);
        },
        (err: unknown) => {
          // the edits after this one start again from the cap as saved, unless one of them set this cap again
          if (wanted.current && lastEdit.current[key] === edit) wanted.current[key] = saved.current[key];
          setNotSaved((was) => ({ ...was, [key]: err instanceof Error ? err.message : String(err) }));
          setResets((was) => ({ ...was, [key]: was[key] + 1 }));
        },
      )
      .finally(() => {
        pending.current -= 1;
        if (!pending.current) wanted.current = null;
      });
  };
  // what is said of each cap not saved, with the cap still in force
  const notes = (Object.keys(notSaved) as CapKey[]).map((key) => ({ key, text: `The ${key} cap was not saved (still ${caps[key] ? usd(caps[key]) : "none"}): ${notSaved[key]}` }));
  return { change, resets, notes };
}
