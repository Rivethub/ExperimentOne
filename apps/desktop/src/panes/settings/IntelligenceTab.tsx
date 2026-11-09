import type { JSX } from "solid-js";
import { createMemo } from "solid-js";
import type { Account } from "../../lib/types";
import type { SettingsIntelligenceProps } from "./types";
import { Actions, Button, Input, Panel, Pill } from "../../ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import {
  Switch,
  SwitchControl,
  SwitchDescription,
  SwitchInput,
  SwitchLabel,
  SwitchThumb,
} from "#components/ui/switch";

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

type SelectOption = { value: string; label: string };

function capabilityEnabled(value: boolean | undefined): boolean {
  return value === true;
}

function ToggleRow(props: {
  title: string;
  description: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <Switch
      class="flex items-center justify-between gap-4 border-b border-border/60 py-3.5"
      checked={props.on}
      disabled={props.disabled}
      onChange={(checked) => {
        if (checked !== props.on) {
          props.onToggle();
        }
      }}
    >
      <div class="min-w-0">
        <SwitchLabel class="mb-1 block text-sm font-semibold">{props.title}</SwitchLabel>
        <SwitchDescription class="m-0 max-w-[52ch] text-[13px] leading-snug">
          {props.description}
        </SwitchDescription>
      </div>
      <div class="shrink-0">
        <SwitchInput />
        <SwitchControl>
          <SwitchThumb />
        </SwitchControl>
      </div>
    </Switch>
  );
}

function accountLabel(account: Account): string {
  const base = account.label.trim() || account.id;
  if (account.provider === "codex" && account.platform_ready !== true) {
    return `${base} (needs SIWC)`;
  }
  return base;
}

function AccountSelect(props: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  options: SelectOption[];
  onChange: (value: string) => void;
}): JSX.Element {
  const selected = createMemo(
    () => props.options.find((option) => option.value === props.value) ?? props.options[0],
  );

  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-xs tracking-wide text-muted-foreground">{props.label}</span>
      <Select
        id={props.id}
        options={props.options}
        optionValue="value"
        optionTextValue="label"
        value={selected()}
        disabled={props.disabled}
        onChange={(option) => {
          if (option) {
            props.onChange(option.value);
          }
        }}
        itemComponent={(itemProps) => (
          <SelectItem item={itemProps.item}>{itemProps.item.rawValue.label}</SelectItem>
        )}
      >
        <SelectTrigger class="w-full" aria-label={props.label}>
          <SelectValue<SelectOption>>{(state) => state.selectedOption()?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    </div>
  );
}

export function IntelligenceTab(
  props: SettingsIntelligenceProps & { hidden?: boolean },
): JSX.Element {
  const vectorOn = () => capabilityEnabled(props.status?.capabilities.vector_search);
  const wikiOn = () => capabilityEnabled(props.status?.capabilities.wiki);
  const space = () => props.status?.embedding_space?.trim() || "lexical";
  const remoteActive = () => space() !== "lexical";
  const embedUsesCodex = () => props.embedAccountId.trim().length > 0;
  const codexAccounts = createMemo(() => props.accounts.filter((a) => a.provider === "codex"));

  const embedOptions = createMemo((): SelectOption[] => [
    { value: "", label: "Lexical (offline)" },
    ...codexAccounts().map((account) => ({
      value: account.id,
      label: `Codex · ${accountLabel(account)}`,
    })),
  ]);

  const wikiOptions = createMemo((): SelectOption[] => [
    { value: "", label: "Any linked account" },
    ...props.accounts.map((account) => ({
      value: account.id,
      label: `${account.provider} · ${accountLabel(account)}`,
    })),
  ]);

  return (
    <Panel
      class="m-0"
      hidden={props.hidden}
      aria-hidden={props.hidden}
      title="Workers"
      lede="Configure which accounts and models power embeddings and summaries. Saving a Codex embedding account binds SIWC if needed, then enables remote vectors."
    >
      <ToggleRow
        title="Vector search"
        description="Semantic search over history. Lexical stays offline; pick a Codex account below for remote embeddings."
        on={vectorOn()}
        disabled={props.busy}
        onToggle={() => {
          props.onToggleCapability("vector_search", !vectorOn());
        }}
      />
      <ToggleRow
        title="Wiki worker"
        description="Keep the markdown tree updated from captures."
        on={wikiOn()}
        disabled={props.busy}
        onToggle={() => {
          props.onToggleCapability("wiki", !wikiOn());
        }}
      />

      <div class="my-4 flex flex-col gap-4">
        <section class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <h3 class="m-0 text-sm font-semibold">Embeddings</h3>
            <Pill class="rounded-full px-1.5 py-0 text-[10px] uppercase tracking-wider">
              {remoteActive() ? "remote" : "lexical"}
            </Pill>
          </div>
          <AccountSelect
            id="intelligence-embed-account"
            label="Account"
            value={props.embedAccountId}
            disabled={props.busy}
            options={embedOptions()}
            onChange={(next) => {
              props.onEmbedAccountChange(next);
              if (next && !props.embedModel.trim()) {
                props.onEmbedModelChange(DEFAULT_EMBED_MODEL);
              }
            }}
          />
          <label for="intelligence-embed-model" class="flex flex-col gap-1.5">
            <span class="text-xs tracking-wide text-muted-foreground">Model</span>
            <Input
              id="intelligence-embed-model"
              placeholder={DEFAULT_EMBED_MODEL}
              value={props.embedModel}
              disabled={props.busy || !embedUsesCodex()}
              onChange={(e) => {
                props.onEmbedModelChange(e.target.value);
              }}
            />
          </label>
        </section>

        <section class="flex flex-col gap-3">
          <h3 class="m-0 text-sm font-semibold">Summaries / wiki</h3>
          <AccountSelect
            id="intelligence-wiki-account"
            label="Account"
            value={props.wikiAccountId}
            disabled={props.busy}
            options={wikiOptions()}
            onChange={(next) => {
              props.onWikiAccountChange(next);
            }}
          />
          <label for="intelligence-wiki-model" class="flex flex-col gap-1.5">
            <span class="text-xs tracking-wide text-muted-foreground">Model</span>
            <Input
              id="intelligence-wiki-model"
              placeholder="optional, e.g. claude-sonnet-4-5"
              value={props.wikiModel}
              disabled={props.busy}
              onChange={(e) => {
                props.onWikiModelChange(e.target.value);
              }}
            />
          </label>
        </section>
      </div>

      <Actions>
        <Button variant="primary" disabled={props.busy} onClick={props.onSaveIntelligence}>
          Save workers
        </Button>
        <Button variant="ghost" disabled={props.busy} onClick={props.onRunWorkers}>
          Run workers once
        </Button>
      </Actions>
      <p class="mt-2">
        <Button variant="link" onClick={props.onOpenRuntime}>
          Open Runtime dashboard
        </Button>
      </p>
      <p class="mt-3 max-w-[56ch] text-[12.5px] leading-snug text-muted-foreground">
        Search space: <code>{space()}</code>. Choosing a Codex embedding account and saving will
        complete Sign in with ChatGPT (SIWC) if needed, then backfill remote vectors.
      </p>
    </Panel>
  );
}
