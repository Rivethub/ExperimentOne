# ClickHouse (local sidecar)

Rivet uses ClickHouse as the **sole capture store**. The desktop/runtime boots a
bundled `clickhouse` binary when present, or connects to `RIVET_CLICKHOUSE_URL`.

## Boot

1. Resolve binary (`RIVET_CLICKHOUSE_BIN`, sidecar next to the app, or PATH)
2. Write `config.xml` under the Rivet data dir
3. Start `clickhouse server`
4. `CREATE DATABASE rivet` + `capture_events` MergeTree
5. All ingest / recent / search / export / MCP keyword reads go through CH

```bash
# status.capture_backend → "clickhouse"
echo $RIVET_CLICKHOUSE_URL   # optional remote/override, e.g. http://127.0.0.1:8123
```

Without a sidecar **and** without `RIVET_CLICKHOUSE_URL`, `rivetd` refuses to start.

| Platform | Notes |
|----------|--------|
| macOS / Linux x64 & arm64 | Official single binary via `scripts/build-sidecars.sh` |
| Windows aarch64 | No official CH binary yet — set `RIVET_CLICKHOUSE_BIN` or URL |

## Embeddings (HNSW)

Vectors live in ClickHouse `embeddings` keyed by `space`. The default
**lexical** space uses a native `vector_similarity('hnsw', 'cosineDistance', 64)`
index. Optional remote Codex/OpenAI spaces (`openai:{model}`) store full-dim
vectors in the same table; search filters `length(dims)` and uses
`ORDER BY cosineDistance(dims, q) LIMIT k` (HNSW applies to 64-d lexical rows).

## Meta (not ClickHouse)

Quota history samples, wiki page index, topics, summaries, and job cursors live
as JSON/JSONL under `{data}/meta/` — see `rivet-store` `MetaStore`.
