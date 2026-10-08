import { Link } from "wouter";
import { Eye, RotateCcw } from "lucide-react";
import type { DesignerSession, Settings } from "../api";
import { Select } from "../Select";
import { Button, cx } from "../ui";

/** The bar under the designer's title: the LLM and the system prompt this conversation is held with, Start over, and the system prompt shown. */
export function SessionBar({ settings, using, choose, canRestart, onRestart, showingSystem, onShowSystem }: {
  settings: Settings | undefined;
  using: DesignerSession;
  choose(change: DesignerSession): void;
  canRestart: boolean;
  onRestart(): void;
  showingSystem: boolean;
  onShowSystem(): void;
}) {
  const llms = settings?.llms ?? [];
  const instructions = settings?.designerInstructions ?? [];
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
      <Select
        size="sm"
        className="min-w-0 grow basis-0"
        label="LLM"
        searchHint="Search your LLMs"
        value={using.llm ?? ""}
        onChange={(id) => choose({ llm: id })}
        options={llms.map((l) => ({ value: l.id, label: l.name || l.model, detail: `${l.name ? `${l.model} · ` : ""}${l.vision ? "vision · " : ""}${Math.round(l.contextSize / 1000)}k context` }))}
        footer={() => <Link href="/settings/designer" className="text-xs text-ink-2 underline">Add or edit LLMs in Settings</Link>}
      />
      <Select
        size="sm"
        className="min-w-0 grow basis-0"
        label="System prompt"
        searchHint="Search your system prompts"
        value={using.instruction || "none"}
        onChange={(id) => choose({ instruction: id === "none" ? "" : id })}
        options={[{ value: "none", label: "No system prompt", detail: "The designer writes its usual way." }, ...instructions.map((i) => ({ value: i.id, label: i.name, detail: i.text.replace(/\s+/g, " ").slice(0, 160) }))]}
        footer={() => <Link href="/settings/designer" className="text-xs text-ink-2 underline">Write your own system prompts in Settings</Link>}
      />
      <Button
        size="sm"
        tone="quiet"
        className="shrink-0"
        disabled={!canRestart}
        title="Clear this conversation and start again. What is in your form stays."
        onClick={onRestart}
      >
        <RotateCcw size={13} /> Start over
      </Button>
      <button
        type="button"
        aria-pressed={showingSystem}
        aria-label="Show the system prompt"
        title="What the designer is told for this form, word for word: the model's prompting guide, your system prompt, what it knows of the clip, the cast and the LoRAs, and the reply format."
        onClick={onShowSystem}
        className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-hover", showingSystem ? "bg-accent-wash text-accent" : "text-ink-2 hover:text-ink")}
      >
        <Eye size={14} />
      </button>
    </div>
  );
}
