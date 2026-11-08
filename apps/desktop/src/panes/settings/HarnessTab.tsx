import { isDefined } from "../../lib/nullish";
import type { SettingsHarnessProps } from "./types";
import { Actions, Banner, Button, Kv, KvRow, Panel, Snippet } from "../../ui";
import styles from "../../styles/app.module.css";

export function HarnessTab({
  hidden,
  ...harness
}: SettingsHarnessProps & { hidden?: boolean }): React.ReactElement {
  const note = harness.harnessNote;
  const envHint = note?.env_hint;

  return (
    <Panel
      className={styles.settingsPanel}
      hidden={hidden}
      aria-hidden={hidden}
      title="Harness (advanced)"
      lede={
        <>
          One-click setup lives on each Claude / Codex account. This tab points harnesses at the
          Rivet proxy (sole live traffic ingress), optionally installs session→project bindings +
          MCP, and can import old on-disk transcripts. Plugins never post traffic — they only help
          the proxy attach project/cwd. Restart each harness after install.
        </>
      }
    >
      <div className={styles.settingsFields} style={{ marginBottom: 16 }}>
        <strong>Capture ladder</strong>
        <p className={styles.muted} style={{ marginTop: 4, marginBottom: 8 }}>
          Live capture is proxy-only. Plugins are optional fidelity for that path. Offline import
          backfills history and never replaces the proxy.
        </p>
        <Kv>
          <KvRow label="L1 Route" value="Point harness at Rivet proxy (required for live capture)" />
          <KvRow label="L2 Wire" value="Live sessions with real harness IDs (best fidelity)" />
          <KvRow label="L2 Soft" value="No session marker → stable soft: hash grouping" />
          <KvRow
            label="L2.5 Plugin (optional)"
            value="Session bind cwd → project_id at ingest + Rivet MCP; no content ingress"
          />
          <KvRow label="L3 Bodies" value="Full turns spilled to blobs/ (preview stays short)" />
          <KvRow label="L4 Import" value="Optional offline Claude / Codex / Cursor transcripts" />
          <KvRow
            label="Project"
            value="Hard evidence only; wire headers + optional plugin beat cwd scraping"
          />
        </Kv>
        <Actions style={{ marginTop: 8 }}>
          <Button
            variant="primary"
            disabled={harness.busy}
            onClick={() => {
              harness.onIngestLocal();
            }}
          >
            Import local sessions
          </Button>
        </Actions>
      </div>

      <Actions>
        <Button
          variant="primary"
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteAllHarnesses();
          }}
        >
          Install Claude + Codex + Cursor
        </Button>
      </Actions>
      <p className={styles.muted} style={{ marginTop: 8, marginBottom: 8 }}>
        Writes proxy settings plus optional session→project bindings and Rivet MCP. Capture works
        with proxy routing alone. Restart Claude Code, Codex, and Cursor afterward so config loads.
      </p>
      <Actions>
        <Button
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteHarness("claude", "user");
          }}
        >
          Install into ~/.claude
        </Button>
        <Button
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteHarness("codex", "user");
          }}
        >
          Install into ~/.codex
        </Button>
        <Button
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteHarness("cursor", "user");
          }}
        >
          Install into ~/.cursor
        </Button>
      </Actions>
      <Actions style={{ marginTop: 8 }}>
        <Button onClick={harness.onLoadClaude}>Copy Claude snippet</Button>
        <Button onClick={harness.onLoadCodex}>Copy Codex snippet</Button>
        <Button onClick={harness.onLoadMcp}>Copy MCP snippet</Button>
        <Button
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteHarness("claude", "isolated");
          }}
        >
          Isolated Claude dir
        </Button>
        <Button
          disabled={harness.busy}
          onClick={() => {
            harness.onWriteHarness("codex", "isolated");
          }}
        >
          Isolated Codex dir
        </Button>
      </Actions>
      {isDefined(note) && (
        <div className={styles.harnessResult}>
          <Banner tone="note">{note.note}</Banner>
          <Kv>
            <KvRow label="Path" value={note.path} />
            {isDefined(note.backup_path) && note.backup_path !== "" ? (
              <KvRow label="Backup" value={note.backup_path} />
            ) : null}
            {isDefined(envHint) && envHint !== "" ? <KvRow label="Env" value={envHint} /> : null}
          </Kv>
          {isDefined(envHint) && envHint !== "" ? (
            <Actions>
              <Button
                onClick={() => {
                  harness.onCopyText(envHint);
                }}
              >
                Copy env export
              </Button>
            </Actions>
          ) : null}
        </div>
      )}
      {isDefined(harness.snippet) && harness.snippet !== "" && (
        <div style={{ marginTop: 12 }}>
          <Actions>
            <Button
              onClick={() => {
                harness.onCopyText(harness.snippet);
              }}
            >
              Copy snippet
            </Button>
          </Actions>
          <Snippet>{harness.snippet}</Snippet>
        </div>
      )}
    </Panel>
  );
}
