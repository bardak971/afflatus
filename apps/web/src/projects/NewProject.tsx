import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { api, type Project } from "../api";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "../Dialog";
import { FieldRow } from "../fields/FieldRow";
import { Keys } from "../Keys";
import { queryKeys } from "../queryKeys";
import { Button, cx, ErrorNote, fieldClass } from "../ui";

/** A new project, named here (Projects.tsx): a chunk of its own, since it is opened now and then and the rail is in the first load. */
export function NewProject({ onClose, onMade }: { onClose(): void; onMade(p: Project): void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const make = useMutation({
    mutationFn: (n: string) => api.createProject(n),
    onSuccess: (p) => {
      // its root folder: the server says it with a "library" event, which reads the folders again
      void client.invalidateQueries({ queryKey: queryKeys.projects.all() });
      onMade(p);
    },
  });
  return (
    // over the Projects panel it is opened from
    <Dialog label="New project" onClose={onClose} z="z-toast" className={DIALOG}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) make.mutate(name.trim());
        }}
      >
        <DialogHead icon={<FolderPlus size={16} />} title="New project" sub="Drafts, timelines and folders, with a root folder of its name" onClose={onClose} />
        <FieldRow label="Name" htmlFor="new-project-name" note="A project holds drafts, timelines and folders. It gets a root folder of the same name, where its renders land unless another folder of it is open. The library, the drafts and the timelines then show this project's.">
          <input id="new-project-name" autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" maxLength={120} className={cx(fieldClass, "h-10")} />
        </FieldRow>
        {make.isError && <ErrorNote>{make.error.message}</ErrorNote>}
        <DialogFoot>
          <Button tone="quiet" type="button" onClick={onClose}>Cancel <Keys keys="Esc" size="sm" /></Button>
          <Button tone="primary" type="submit" disabled={!name.trim() || make.isPending}>Create <Keys keys="Enter" size="sm" /></Button>
        </DialogFoot>
      </form>
    </Dialog>
  );
}
