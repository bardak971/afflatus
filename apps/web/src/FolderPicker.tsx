import type { Ref } from "react";

/**
 * The computer's folder picker, unseen: a click on it (`ref.current.click()`) asks for a whole directory, its
 * sub-directories included. `onFiles` hears what was picked (nothing when it was closed without a pick), and the
 * same folder can be picked again after. The Projects panel's and the command bar's "Import a folder…".
 */
export function FolderPicker({ ref, onFiles }: { ref: Ref<HTMLInputElement>; onFiles(files: File[]): void }) {
  return (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      aria-hidden="true"
      tabIndex={-1}
      {...{ webkitdirectory: "", directory: "" }}
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        onFiles(files);
      }}
    />
  );
}
