import type { JSX } from "solid-js";
import { isDefined } from "../lib/nullish";
import type { ProviderQuota } from "../lib/types";
import type { MetricMode } from "./types";
import { StaleStamp } from "./StaleStamp";
import { cn } from "#lib/utils";

const icoTone = {
  claude: "bg-[var(--claude-dim)] text-[var(--claude)]",
  codex: "bg-[var(--codex-dim)] text-[var(--codex)]",
  generic: "bg-secondary text-muted-foreground",
} as const;

const bigTone = {
  claude: "text-[var(--claude)]",
  codex: "text-[var(--codex)]",
  generic: "text-foreground",
} as const;

export function QuotaProviderCardHeader(props: {
  name: string;
  ico: string;
  icoClass: "claude" | "codex" | "generic";
  count: number;
  metricMode: MetricMode;
  pq: ProviderQuota | null;
  knownQuota: boolean;
  capacity: number;
  observedAt?: string | null;
  headline: number;
  unit: string;
  capLabel: string;
}): JSX.Element {
  return (
    <div class="mb-2.5 flex items-start justify-between gap-4">
      <div class="flex items-center gap-2.5">
        <div
          class={cn(
            "grid size-7 place-items-center rounded-lg text-[13px] font-bold",
            icoTone[props.icoClass],
          )}
        >
          {props.ico}
        </div>
        <div>
          <h2 class="m-0 text-[15px] font-semibold">{props.name}</h2>
          <div class="text-xs text-muted-foreground">
            {props.count} account{props.count === 1 ? "" : "s"}
            {props.pq !== null ? ` · ${props.pq.known_count ?? 0}/${props.count} reporting` : ""}
            {props.knownQuota ? ` · pool ${Math.round(props.capacity)}%` : ""} · {props.metricMode}
            {isDefined(props.observedAt) && props.observedAt !== "" ? (
              <>
                {" "}
                · <StaleStamp observedAt={props.observedAt} />
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div class="text-right" title="Sum of remaining % across loaded accounts vs capacity">
        <div
          class={cn(
            "text-[28px] leading-none font-bold tracking-tight tabular-nums",
            bigTone[props.icoClass],
          )}
        >
          {props.headline}
          <span class="ml-1.5 text-[13px] font-medium tracking-normal text-muted-foreground">
            {props.unit}
          </span>
        </div>
        <div class="mt-1 text-xs text-muted-foreground">{props.capLabel}</div>
      </div>
    </div>
  );
}
