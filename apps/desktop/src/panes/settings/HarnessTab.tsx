import type { JSX } from "solid-js";
import { Ellipsis } from "lucide-solid";
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
}: SettingsHarnessProps & { hidden?: boolean }): JSX.Element {
  const note = harness.harnessNote;
  const envHint = note?.env_hint;

  return (
    <Panel
      class="m-0"
      hidden={hidden}
      aria-hidden={hidden}
      title="Harness (advanced)"
      lede={
        <>
          One-click setup lives on each Claude / Codex account. This tab points harnesses at the
          Rivet proxy (sole live capture ingress), optionally installs session→project bindings +
          MCP, and can import old on-disk transcripts. Plugins never post captures — they only help
          the proxy attach project/cwd. Restart each harness after install.
        </>
      }
    >
      <Actions spaced={false} class="mb-4">
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

      <div class="mb-2 text-xs tracking-wide text-muted-foreground">Write into home config</div>
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
      <p class="mt-2 mb-2 text-[13px] text-muted-foreground">
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
        <DropdownMenu placement="bottom-end">
          <DropdownMenuTrigger
            as={ShadcnButton}
            variant="ghost"
            size="icon"
            aria-label="More harness actions"
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
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
        <div class="mt-4 border-t border-border/60 pt-3">
          <p class="mb-2 text-[13px] text-muted-foreground">{note.note}</p>
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
        <div class="mt-3">
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
