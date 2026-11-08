import { isDefined } from "../../nullish";
import type { SettingsIntelligenceProps } from "./types";
import { Actions, Banner, Button, Input, Panel } from "../../ui";
import { cx } from "../../styles/cx";
import styles from "../../styles/app.module.css";

function capabilityEnabled(
  value: boolean | undefined,
): boolean {
  return value === true;
}

export function IntelligenceTab({
  hidden,
  bagNote,
  ...intelligence
}: SettingsIntelligenceProps & { hidden?: boolean }): React.ReactElement {
  const vectorOn = capabilityEnabled(intelligence.status?.capabilities.vector_search);
  const wikiOn = capabilityEnabled(intelligence.status?.capabilities.wiki);

  return (
    <Panel
      className={styles.settingsPanel}
      hidden={hidden}
      aria-hidden={hidden}
      title="Intelligence"
      lede="Choose which workers run and which models they use. Live worker status lives on the Runtime dashboard."
    >
      <div className={styles.settingsToggleRow}>
        <div>
          <strong>Vector search</strong>
          <p>Lexical embeddings for MCP search (offline, no remote model required).</p>
        </div>
        <button
          type="button"
          className={cx(styles.togglePill, vectorOn ? styles.on : "")}
          disabled={intelligence.busy}
          onClick={() => {
            intelligence.onToggleCapability("vector_search", !vectorOn);
          }}
        >
          <span className={styles.toggleDot} aria-hidden />
          {vectorOn ? "Enabled" : "Disabled"}
        </button>
      </div>
      <div className={styles.settingsToggleRow}>
        <div>
          <strong>Wiki worker</strong>
          <p>Keep the markdown tree updated from captured traffic.</p>
        </div>
        <button
          type="button"
          className={cx(styles.togglePill, wikiOn ? styles.on : "")}
          disabled={intelligence.busy}
          onClick={() => {
            intelligence.onToggleCapability("wiki", !wikiOn);
          }}
        >
          <span className={styles.toggleDot} aria-hidden />
          {wikiOn ? "Enabled" : "Disabled"}
        </button>
      </div>
      <div className={styles.settingsFields}>
        <label htmlFor="intelligence-embed-model">
          <span>
            Embedding model <em className={styles.fieldBadge}>v1 lexical</em>
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
        <label htmlFor="intelligence-wiki-model">
          <span>Wiki text model</span>
          <Input
            id="intelligence-wiki-model"
            placeholder="optional, e.g. claude-sonnet-4-5"
            value={intelligence.wikiModel}
            onChange={(e) => { intelligence.onWikiModelChange(e.target.value); }}
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
        <Button disabled={intelligence.busy} onClick={intelligence.onRunWorkers}>
          Run workers once
        </Button>
        <Button onClick={intelligence.onOpenRuntime}>Open Runtime</Button>
      </Actions>
      <Banner tone="note">
        Lexical embeddings stay consistent with MCP search. The embedding model field is reserved
        for a later remote-vector release.
      </Banner>
      {isDefined(bagNote) && bagNote !== "" ? <Banner tone="note">{bagNote}</Banner> : null}
    </Panel>
  );
}
