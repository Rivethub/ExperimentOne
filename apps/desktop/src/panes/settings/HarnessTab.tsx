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
          One-click setup lives on each Claude / Codex account. This tab is for copying snippets or
          writing an isolated Rivet config dir (default installs stay untouched; set{" "}
          <code>CLAUDE_CONFIG_DIR</code> / <code>CODEX_HOME</code>).
        </>
      }
    >
      <Actions>
        <Button
          variant="primary"
          disabled={harness.busy}
          onClick={() => { harness.onWriteHarness("claude", "user"); }}
        >
          Install into ~/.claude
        </Button>
        <Button
          variant="primary"
          disabled={harness.busy}
          onClick={() => { harness.onWriteHarness("codex", "user"); }}
        >
          Install into ~/.codex
        </Button>
      </Actions>
      <Actions style={{ marginTop: 8 }}>
        <Button onClick={harness.onLoadClaude}>Copy Claude snippet</Button>
        <Button onClick={harness.onLoadCodex}>Copy Codex snippet</Button>
        <Button onClick={harness.onLoadMcp}>Copy MCP snippet</Button>
        <Button
          disabled={harness.busy}
          onClick={() => { harness.onWriteHarness("claude", "isolated"); }}
        >
          Isolated Claude dir
        </Button>
        <Button disabled={harness.busy} onClick={() => { harness.onWriteHarness("codex", "isolated"); }}>
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
              <Button onClick={() => { harness.onCopyText(envHint); }}>Copy env export</Button>
            </Actions>
          ) : null}
        </div>
      )}
      {isDefined(harness.snippet) && harness.snippet !== "" && (
        <div style={{ marginTop: 12 }}>
          <Actions>
            <Button onClick={() => { harness.onCopyText(harness.snippet); }}>Copy snippet</Button>
          </Actions>
          <Snippet>{harness.snippet}</Snippet>
        </div>
      )}
    </Panel>
  );
}
