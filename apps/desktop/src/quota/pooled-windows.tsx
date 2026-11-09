import { For, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { fmtPct } from "../lib/provider-utils";
import { isDefined } from "../lib/nullish";
import type { QuotaAccountUx } from "./types";
import {
  distinctWindowIds,
  finiteRemaining,
  pooledAccountDisplay,
  sortAccountsById,
  windowForAccount,
} from "./pooled-window-ids";
import { cx, styles } from "#styles";

function SegmentBar(props: {
  accounts: QuotaAccountUx[];
  windowId: string;
  color: string;
  onSelect: (a: QuotaAccountUx) => void;
}): JSX.Element {
  return (
    <div class={styles.poolWindowBar} role="group" aria-label="Account limit segments">
      <For each={props.accounts}>
        {(a) => {
          const w = () => windowForAccount(a, props.windowId);
          const rem = () => w()?.remaining_pct;
          const has = () => finiteRemaining(rem());
          const remaining = () =>
            has() && isDefined(rem()) ? Math.max(0, Math.min(100, rem() as number)) : 0;
          const used = () => (has() ? 100 - remaining() : 100);
          const empty = () => has() && remaining() <= 0.5;
          const label = () => `${pooledAccountDisplay(a)} · ${fmtPct(rem() ?? null)} remaining`;
          return (
            <button
              type="button"
              class={cx(
                styles.poolSeg,
                empty() ? styles.isEmpty : "",
                a.loaded ? "" : styles.isDown,
              )}
              title={label()}
              aria-label={label()}
              onClick={() => {
                props.onSelect(a);
              }}
            >
              <div class={styles.poolSegFill} style={{ "flex-grow": Math.max(0.05, remaining()) }}>
                <span class={styles.poolSegRemain} style={{ background: props.color }} />
              </div>
              <div
                class={styles.poolSegHatch}
                style={{ "flex-grow": Math.max(0.05, used()) }}
                title="Used until reset restores"
              />
            </button>
          );
        }}
      </For>
    </div>
  );
}

export function PooledWindowCards(props: {
  accounts: QuotaAccountUx[];
  color: string;
  onAccountSelect: (a: QuotaAccountUx) => void;
}): JSX.Element {
  const windows = createMemo(() => distinctWindowIds(props.accounts));
  const ordered = createMemo(() => sortAccountsById(props.accounts));

  return (
    <div class={styles.poolWindows}>
      <For each={windows()}>
        {(win) => (
          <div class={styles.poolWindowCard}>
            <div class={styles.poolWindowHead}>
              <span class={styles.poolWindowLabel}>{win.label}</span>
              <span class={styles.poolWindowHint}>
                Segments = accounts (fixed order) · hatch = used until reset
              </span>
            </div>
            <SegmentBar
              accounts={ordered()}
              windowId={win.id}
              color={props.color}
              onSelect={(a) => props.onAccountSelect(a)}
            />
            <div class={styles.poolWindowLegend}>
              <For each={ordered()}>
                {(a) => {
                  const w = () => windowForAccount(a, win.id);
                  return (
                    <span class={styles.poolLegendItem}>
                      <span
                        class={cx(styles.qaDot, styles.ok)}
                        style={{ background: props.color }}
                      />
                      {pooledAccountDisplay(a)} {fmtPct(w()?.remaining_pct ?? null)}
                    </span>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
