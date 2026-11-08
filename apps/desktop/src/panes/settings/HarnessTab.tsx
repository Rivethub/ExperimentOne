import type { SettingsHarnessProps } from "./types";
import { Actions, Banner, Button, Kv, KvRow, Panel, Snippet } from "../../ui";
import styles from "../../styles/app.module.css";

export function HarnessTab({ hidden, ...harness }: SettingsHarnessProps & { hidden?: boolean }) {
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
          onClick={() => harness.onWriteHarness("claude", "user")}
        >
          Install into ~/.claude
        </Button>
        <Button
          variant="primary"
          disabled={harness.busy}
          onClick={() => harness.onWriteHarness("codex", "user")}
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
          onClick={() => harness.onWriteHarness("claude", "isolated")}
        >
          Isolated Claude dir
        </Button>
        <Button disabled={harness.busy} onClick={() => harness.onWriteHarness("codex", "isolated")}>
          Isolated Codex dir
        </Button>
      </Actions>
      {harness.harnessNote && (
        <div className={styles.harnessResult}>
          <Banner tone="note">{harness.harnessNote.note}</Banner>
          <Kv>
            <KvRow label="Path" value={harness.harnessNote.path} />
            {harness.harnessNote.backup_path && (
              <KvRow label="Backup" value={harness.harnessNote.backup_path} />
            )}
            {harness.harnessNote.env_hint && (
              <KvRow label="Env" value={harness.harnessNote.env_hint} />
            )}
          </Kv>
          {harness.harnessNote.env_hint && (
            <Actions>
              <Button onClick={() => harness.onCopyText(harness.harnessNote!.env_hint)}>
                Copy env export
              </Button>
            </Actions>
          )}
        </div>
      )}
      {harness.snippet && (
        <div style={{ marginTop: 12 }}>
          <Actions>
            <Button onClick={() => harness.onCopyText(harness.snippet)}>Copy snippet</Button>
          </Actions>
          <Snippet>{harness.snippet}</Snippet>
        </div>
      )}
    </Panel>
  );
}
