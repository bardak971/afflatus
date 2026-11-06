import { useMutation, useQueryClient } from "@tanstack/react-query";
import { boxEditFamily, SETTING_HELP } from "@afflatus/core";
import { api } from "../../api";
import { useRecipes, useSettings } from "../../data";
import { allBoxEditors, useBoxEditors } from "../../paintFix/boxEditors";
import { queryKeys } from "../../queryKeys";
import { Select } from "../../Select";
import { Failed } from "../../ui";
import { Block, Card, Row } from "./Rows";

/**
 * The Stage's model setting (card #284): which instruction editor Edit in box uses on a picture whose own model edits by
 * no instruction. Every editor the recipes have is offered: one turned off or without its files greyed (a pod fetches
 * files; Edit in box falls back on another while it is off).
 */
export function BoxEditCard() {
  const settings = useSettings();
  const all = useRecipes().data?.recipes ?? [];
  const client = useQueryClient();
  const { editors } = useBoxEditors(undefined);
  const save = useMutation({
    mutationFn: (boxEditModel: string) => api.saveSettings({ boxEditModel }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
  const value = boxEditFamily(all, settings.data?.boxEditModel);
  return (
    <Card title="Paint and fix">
      <Row setting="models.boxEdit" label="Edit model for boxes" help={SETTING_HELP.boxEditModel}>
        <Select
          label="Edit model for boxes"
          value={value}
          // all of them, so that the one set always shows: one turned off (Settings › Models) or without its files greyed
          options={allBoxEditors(all).map((r) => {
            const e = editors.find((x) => x.family === r.family);
            return { value: r.family, label: r.boxEditor.name, ...(!e ? { note: "turned off", muted: true } : e.ready ? {} : { note: "files missing", muted: true }) };
          })}
          onChange={(v) => save.mutate(v)}
          disabled={save.isPending}
        />
      </Row>
      {save.isError && <Block><Failed what="Not saved" error={save.error} /></Block>}
    </Card>
  );
}
