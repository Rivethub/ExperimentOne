import type { SettingsIntelligenceProps } from "./types";
import { Actions, Button, Input, Panel, Pill } from "../../ui";
import { cn } from "#lib/utils";

function capabilityEnabled(value: boolean | undefined): boolean {
  return value === true;
}

function ToggleRow({
  title,
  description,
  on,
  disabled,
  onToggle,
}: {
  title: string;
  description: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-3.5">
      <div>
        <strong className="mb-1 block text-sm font-semibold">{title}</strong>
        <p className="m-0 max-w-[52ch] text-[13px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={cn(
          "inline-flex h-7 w-12 shrink-0 items-center rounded-full border px-1 transition-colors",
          on ? "border-emerald-500/40 bg-emerald-500/20" : "border-border bg-card",
        )}
        disabled={disabled}
        onClick={onToggle}
      >
        <span
          className={cn(
            "size-5 rounded-full transition-transform",
            on ? "translate-x-5 bg-emerald-400" : "translate-x-0 bg-muted-foreground/60",
          )}
          aria-hidden
        />
        <span className="sr-only">{on ? "Enabled" : "Disabled"}</span>
      </button>
    </div>
  );
}

export function IntelligenceTab({
  hidden,
  ...intelligence
}: SettingsIntelligenceProps & { hidden?: boolean }): React.ReactElement {
  const vectorOn = capabilityEnabled(intelligence.status?.capabilities.vector_search);
  const wikiOn = capabilityEnabled(intelligence.status?.capabilities.wiki);

  return (
    <Panel
      className="m-0"
      hidden={hidden}
      aria-hidden={hidden}
      title="Intelligence"
      lede="Choose which workers run and which models they use. Live worker status lives on the Runtime dashboard."
    >
      <ToggleRow
        title="Vector search"
        description="Lexical embeddings for MCP search (offline, no remote model required)."
        on={vectorOn}
        disabled={intelligence.busy}
        onToggle={() => {
          intelligence.onToggleCapability("vector_search", !vectorOn);
        }}
      />
      <ToggleRow
        title="Wiki worker"
        description="Keep the markdown tree updated from captures."
        on={wikiOn}
        disabled={intelligence.busy}
        onToggle={() => {
          intelligence.onToggleCapability("wiki", !wikiOn);
        }}
      />
      <div className="my-4 flex flex-col gap-3">
        <label htmlFor="intelligence-embed-model" className="flex flex-col gap-1.5">
          <span className="inline-flex items-center gap-2 text-xs tracking-wide text-muted-foreground">
            Embedding model{" "}
            <Pill className="rounded-full px-1.5 py-0 text-[10px] uppercase tracking-wider">
              v1 lexical
            </Pill>
          </span>
          <Input
            id="intelligence-embed-model"
            placeholder="reserved — v1 uses lexical vectors"
            value={intelligence.embedModel}
            disabled
            readOnly
            title="Reserved for a future remote-embedding release; search stays lexical."
          />
        </label>
        <label htmlFor="intelligence-wiki-model" className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-muted-foreground">Wiki text model</span>
          <Input
            id="intelligence-wiki-model"
            placeholder="optional, e.g. claude-sonnet-4-5"
            value={intelligence.wikiModel}
            onChange={(e) => {
              intelligence.onWikiModelChange(e.target.value);
            }}
          />
        </label>
      </div>
      <Actions>
        <Button
          variant="primary"
          disabled={intelligence.busy}
          onClick={intelligence.onSaveIntelligence}
        >
          Save models
        </Button>
        <Button variant="ghost" disabled={intelligence.busy} onClick={intelligence.onRunWorkers}>
          Run workers once
        </Button>
      </Actions>
      <p className="mt-2">
        <Button variant="link" onClick={intelligence.onOpenRuntime}>
          Open Runtime dashboard
        </Button>
      </p>
      <p className="mt-3 max-w-[56ch] text-[12.5px] leading-snug text-muted-foreground">
        Lexical embeddings stay consistent with MCP search. The embedding model field is reserved
        for a later remote-vector release.
      </p>
    </Panel>
  );
}
