import type { SettingsIntelligenceProps } from "./types";
import { Actions, Banner, Button, Input, Panel } from "../../ui";
import { cx } from "../../styles/cx";
import styles from "../../styles/app.module.css";

export function IntelligenceTab({
  hidden,
  ...intelligence
}: SettingsIntelligenceProps & { hidden?: boolean }) {
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
          className={cx(
            styles.togglePill,
            intelligence.status?.capabilities.vector_search ? styles.on : "",
          )}
          disabled={intelligence.busy}
          onClick={() =>
            intelligence.onToggleCapability(
              "vector_search",
              !intelligence.status?.capabilities.vector_search,
            )
          }
        >
          <span className={styles.toggleDot} aria-hidden />
          {intelligence.status?.capabilities.vector_search ? "Enabled" : "Disabled"}
        </button>
      </div>
      <div className={styles.settingsToggleRow}>
        <div>
          <strong>Wiki worker</strong>
          <p>Keep the markdown tree updated from captured traffic.</p>
        </div>
        <button
          type="button"
          className={cx(styles.togglePill, intelligence.status?.capabilities.wiki ? styles.on : "")}
          disabled={intelligence.busy}
          onClick={() =>
            intelligence.onToggleCapability("wiki", !intelligence.status?.capabilities.wiki)
          }
        >
          <span className={styles.toggleDot} aria-hidden />
          {intelligence.status?.capabilities.wiki ? "Enabled" : "Disabled"}
        </button>
      </div>
      <div className={styles.settingsFields}>
        <label>
          <span>
            Embedding model <em className={styles.fieldBadge}>v1 lexical</em>
          </span>
          <Input
            placeholder="reserved — v1 uses lexical vectors"
            value={intelligence.embedModel}
            disabled
            readOnly
            title="Reserved for a future remote-embedding release; search stays lexical."
          />
        </label>
        <label>
          <span>Wiki text model</span>
          <Input
            placeholder="optional, e.g. claude-sonnet-4-5"
            value={intelligence.wikiModel}
            onChange={(e) => intelligence.onWikiModelChange(e.target.value)}
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
      {intelligence.bagNote && <Banner tone="note">{intelligence.bagNote}</Banner>}
    </Panel>
  );
}
