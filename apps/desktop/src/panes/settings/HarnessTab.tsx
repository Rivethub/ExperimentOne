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
          One-click setup lives on each Claude / Codex account. This tab points harnesses at the
          Rivet proxy (sole live traffic ingress), optionally installs session→project bindings +
          MCP, and can import old on-disk transcripts. Plugins never post traffic — they only help
          the proxy attach project/cwd. Restart each harness after install.
        </>
      }
    >
      <div className="mb-4">
        <strong className="text-sm">Capture ladder</strong>
        <p className="mt-1 mb-2 text-[13px] text-muted-foreground">
          Live capture is proxy-only. Plugins are optional fidelity for that path. Offline import
          backfills history and never replaces the proxy. Capture stores cwd/bodies as signals and
          sets `project_id` only on hard evidence (explicit field/header, harness {"projects/<id>/"}{" "}
          key, or the Rivet harness plugin).
        </p>
        <Kv>
          <KvRow label="L1 Route" value="Point harness at Rivet proxy (install buttons below)" />
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
        <Actions spaced={false} className="mt-2">
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

      <div className="mb-2 text-xs tracking-wide text-muted-foreground">Write into home config</div>
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
      <p className="mt-2 mb-2 text-[13px] text-muted-foreground">
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
