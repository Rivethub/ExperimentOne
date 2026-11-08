import { Ellipsis } from "lucide-react";
import { Button as ShadcnButton } from "#components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu";
import { isDefined } from "../../lib/nullish";
import type { SettingsHarnessProps } from "./types";
import { Actions, Button, Kv, KvRow, Panel, Snippet } from "../../ui";

export function HarnessTab({
  hidden,
  ...harness
}: SettingsHarnessProps & { hidden?: boolean }): React.ReactElement {
  const note = harness.harnessNote;
  const envHint = note?.env_hint;

  return (
    <Panel
      className="m-0"
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
      <div className="mb-2 text-xs tracking-wide text-muted-foreground">Write into home config</div>
      <Actions>
        <Button
          variant="primary"
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ShadcnButton variant="ghost" size="icon" aria-label="More harness actions">
              <Ellipsis />
            </ShadcnButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={harness.busy} onSelect={harness.onLoadClaude}>
              Copy Claude snippet
            </DropdownMenuItem>
            <DropdownMenuItem disabled={harness.busy} onSelect={harness.onLoadCodex}>
              Copy Codex snippet
            </DropdownMenuItem>
            <DropdownMenuItem disabled={harness.busy} onSelect={harness.onLoadMcp}>
              Copy MCP snippet
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={harness.busy}
              onSelect={() => {
                harness.onWriteHarness("claude", "isolated");
              }}
            >
              Isolated Claude dir
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={harness.busy}
              onSelect={() => {
                harness.onWriteHarness("codex", "isolated");
              }}
            >
              Isolated Codex dir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Actions>
      {isDefined(note) && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="mb-2 text-[13px] text-muted-foreground">{note.note}</p>
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
                variant="ghost"
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
        <div className="mt-3">
          <Actions>
            <Button
              variant="ghost"
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
