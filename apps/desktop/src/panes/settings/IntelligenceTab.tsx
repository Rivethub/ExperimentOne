import type { Account } from "../../lib/types";
import type { SettingsIntelligenceProps } from "./types";
import { Actions, Button, Input, Panel, Pill } from "../../ui";
import { cn } from "#lib/utils";

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

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

function accountLabel(account: Account): string {
  const base = account.label.trim() || account.id;
  if (account.provider === "codex" && account.platform_ready !== true) {
    return `${base} (needs SIWC)`;
  }
  return base;
}

function selectClassName(): string {
  return cn(
    "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none",
    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  );
}

export function IntelligenceTab({
  hidden,
  ...intelligence
}: SettingsIntelligenceProps & { hidden?: boolean }): React.ReactElement {
  const vectorOn = capabilityEnabled(intelligence.status?.capabilities.vector_search);
  const wikiOn = capabilityEnabled(intelligence.status?.capabilities.wiki);
  const space = intelligence.status?.embedding_space?.trim() || "lexical";
  const remoteActive = space !== "lexical";
  const embedUsesCodex = intelligence.embedAccountId.trim().length > 0;
  const codexAccounts = intelligence.accounts.filter((a) => a.provider === "codex");
  const wikiAccounts = intelligence.accounts;

  return (
    <Panel
      className="m-0"
      hidden={hidden}
      aria-hidden={hidden}
      title="Workers"
      lede="Configure which accounts and models power embeddings and summaries. Saving a Codex embedding account binds SIWC if needed, then enables remote vectors."
    >
      <ToggleRow
        title="Vector search"
        description="Semantic search over history. Lexical stays offline; pick a Codex account below for remote embeddings."
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

      <div className="my-4 flex flex-col gap-4">
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-sm font-semibold">Embeddings</h3>
            <Pill className="rounded-full px-1.5 py-0 text-[10px] uppercase tracking-wider">
              {remoteActive ? "remote" : "lexical"}
            </Pill>
          </div>
          <label htmlFor="intelligence-embed-account" className="flex flex-col gap-1.5">
            <span className="text-xs tracking-wide text-muted-foreground">Account</span>
            <select
              id="intelligence-embed-account"
              className={selectClassName()}
              value={intelligence.embedAccountId}
              disabled={intelligence.busy}
              onChange={(e) => {
                const next = e.target.value;
                intelligence.onEmbedAccountChange(next);
                if (next && !intelligence.embedModel.trim()) {
                  intelligence.onEmbedModelChange(DEFAULT_EMBED_MODEL);
                }
              }}
            >
              <option value="">Lexical (offline)</option>
              {codexAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  Codex · {accountLabel(account)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="intelligence-embed-model" className="flex flex-col gap-1.5">
            <span className="text-xs tracking-wide text-muted-foreground">Model</span>
            <Input
              id="intelligence-embed-model"
              placeholder={DEFAULT_EMBED_MODEL}
              value={intelligence.embedModel}
              disabled={intelligence.busy || !embedUsesCodex}
              onChange={(e) => {
                intelligence.onEmbedModelChange(e.target.value);
              }}
            />
          </label>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="m-0 text-sm font-semibold">Summaries / wiki</h3>
          <label htmlFor="intelligence-wiki-account" className="flex flex-col gap-1.5">
            <span className="text-xs tracking-wide text-muted-foreground">Account</span>
            <select
              id="intelligence-wiki-account"
              className={selectClassName()}
              value={intelligence.wikiAccountId}
              disabled={intelligence.busy}
              onChange={(e) => {
                intelligence.onWikiAccountChange(e.target.value);
              }}
            >
              <option value="">Any linked account</option>
              {wikiAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.provider} · {accountLabel(account)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="intelligence-wiki-model" className="flex flex-col gap-1.5">
            <span className="text-xs tracking-wide text-muted-foreground">Model</span>
            <Input
              id="intelligence-wiki-model"
              placeholder="optional, e.g. claude-sonnet-4-5"
              value={intelligence.wikiModel}
              disabled={intelligence.busy}
              onChange={(e) => {
                intelligence.onWikiModelChange(e.target.value);
              }}
            />
          </label>
        </section>
      </div>

      <Actions>
        <Button
          variant="primary"
          disabled={intelligence.busy}
          onClick={intelligence.onSaveIntelligence}
        >
          Save workers
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
        Search space: <code>{space}</code>. Choosing a Codex embedding account and saving will
        complete Sign in with ChatGPT (SIWC) if needed, then backfill remote vectors.
      </p>
    </Panel>
  );
}
