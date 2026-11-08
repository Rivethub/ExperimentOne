# Hybrid search eval (RivetHub-inspired)

Offline corpus for guarding RRF + lexical + boost regressions (no ClickHouse).

## Files

- `corpus.json` — queries, keyword/vector arms, optional docs/boosts/summary ids
- `baseline.json` — expected top-id sets per query

## Cases

- **path** / **pr** — `prefer_lexical_query` must win (paths, `PR #N`)
- **prose** / **shared** — hybrid RRF with summary lineage
- **boosted** — recency/access boosts reorder hybrid results

## How to run

```sh
cargo test -p rivet-store search_eval -- --nocapture
```

When you change fusion/scoring, update `baseline.json` only if the new ranking is intentionally better — never weaken precision on path / `PR #` queries.
