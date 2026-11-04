import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BOX_EDIT_DEFAULT, BOX_EDIT_FAMILIES, BOX_EDITOR_NAMES, SETTING_HELP, type BoxEditFamily } from "@afflatus/core";
import { api } from "../../api";
import { useSettings } from "../../data";
import { useBoxEditors } from "../../paintFix/boxEditors";
import { queryKeys } from "../../queryKeys";
import { Select } from "../../Select";
import { Failed } from "../../ui";
import { Block, Card, Row } from "./Rows";

/**
 * The Stage's model setting (card #284): which instruction editor Edit in box uses on a picture whose own model edits by
 * no instruction. All four are offered: one turned off or without its files greyed (a pod fetches files; Edit in box
 * falls back on another while it is off).
 */
export function BoxEditCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const { editors } = useBoxEditors(undefined);
  const save = useMutation({
    mutationFn: (boxEditModel: BoxEditFamily) => api.saveSettings({ boxEditModel }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
  const value = settings.data?.boxEditModel ?? BOX_EDIT_DEFAULT;
  return (
    <Card title="Paint and fix">
      <Row setting="models.boxEdit" label="Edit model for boxes" help={SETTING_HELP.boxEditModel}>
        <Select
          label="Edit model for boxes"
          value={value}
          // all four, so that the one set always shows: one turned off (Settings › Models) or without its files greyed
          options={BOX_EDIT_FAMILIES.map((f) => {
            const e = editors.find((x) => x.family === f);
            return { value: f, label: BOX_EDITOR_NAMES[f], ...(!e ? { note: "turned off", muted: true } : e.ready ? {} : { note: "files missing", muted: true }) };
          })}
          onChange={(v) => save.mutate(v as BoxEditFamily)}
          disabled={save.isPending}
        />
      </Row>
      {save.isError && <Block><Failed what="Not saved" error={save.error} /></Block>}
    </Card>
  );
}
