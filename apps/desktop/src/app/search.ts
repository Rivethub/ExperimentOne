import type { SearchMode } from "#lib/types";
import type { MetricMode } from "#quota";

export type QuotaSearch = {
  filter: string;
  metric: MetricMode;
};

export type DataSearch = {
  q: string;
  mode: SearchMode;
  thread: string;
};

const METRICS = new Set<MetricMode>(["limits", "tokens", "cost"]);

export function validateQuotaSearch(search: Record<string, unknown>): QuotaSearch {
  const filter = typeof search.filter === "string" && search.filter !== "" ? search.filter : "all";
  const metric =
    typeof search.metric === "string" && METRICS.has(search.metric as MetricMode)
      ? (search.metric as MetricMode)
      : "limits";
  return { filter, metric };
}

export function validateDataSearch(search: Record<string, unknown>): DataSearch {
  const q = typeof search.q === "string" ? search.q : "";
  const mode: SearchMode = search.mode === "vector" ? "vector" : "keyword";
  const thread = typeof search.thread === "string" ? search.thread : "";
  return { q, mode, thread };
}
