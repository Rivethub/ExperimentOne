import type { TrafficEventUx } from "./quota/types";
import { providerKey } from "./providerUtils";

/** Labeled list-price estimates — not billing truth. */
export type CostRates = {
  inPerMTok: number;
  outPerMTok: number;
  note: string;
};

const DEFAULT_RATES: CostRates = {
  inPerMTok: 3,
  outPerMTok: 12,
  note: "Estimate: generic ~$3 in / $12 out per MTok",
};

const RATES: Record<string, CostRates> = {
  claude: {
    inPerMTok: 3,
    outPerMTok: 15,
    note: "Estimate: Claude Sonnet-class ~$3 in / $15 out per MTok (list price)",
  },
  codex: {
    inPerMTok: 2.5,
    outPerMTok: 10,
    note: "Estimate: ChatGPT/Codex-class ~$2.50 in / $10 out per MTok",
  },
  default: DEFAULT_RATES,
};

export function ratesForProvider(provider: string): CostRates {
  const k = providerKey(provider);
  return RATES[k] ?? DEFAULT_RATES;
}

export function estimateCostUsd(provider: string, tokensIn: number, tokensOut: number): number {
  const r = ratesForProvider(provider);
  return (tokensIn / 1_000_000) * r.inPerMTok + (tokensOut / 1_000_000) * r.outPerMTok;
}

export function costForProviderEvents(
  provider: string,
  events: TrafficEventUx[],
): { usd: number; note: string } {
  let tin = 0;
  let tout = 0;
  for (const e of events) {
    tin += e.tokens_in;
    tout += e.tokens_out;
  }
  const usd = estimateCostUsd(provider, tin, tout);
  return { usd, note: ratesForProvider(provider).note };
}

export function fmtUsd(n: number): string {
  if (n < 0.01 && n > 0) {return "<$0.01";}
  if (n < 1) {return `$${n.toFixed(2)}`;}
  if (n < 100) {return `$${n.toFixed(2)}`;}
  return `$${Math.round(n)}`;
}
