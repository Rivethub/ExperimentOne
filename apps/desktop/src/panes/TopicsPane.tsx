import { useEffect, useMemo, useState } from "react";
import { Empty, Input, Panel, Pill } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";
export type TopicCard = {
  slug: string;
  title: string;
  project_id?: string;
  aliases?: string[];
  tags?: string[];
  event_ids?: string[];
  session_ids?: string[];
  summary?: string | null;
  curated?: boolean;
  placement_by?: "heuristic" | "categorizer" | "you";
  decisions?: string[];
  startup_context?: string | null;
  kind?: string;
  parent_slug?: string | null;
  updated_at: string;
};

export type TidyProposalCard = {
  id: string;
  action: string;
  from_slug?: string | null;
  to_slug?: string | null;
  title?: string | null;
  reason: string;
  status: string;
};

export type TagSuggestionCard = {
  id: string;
  session_id: string;
  tag: string;
  status: string;
};

export type FlaggedJobCard = {
  job_key: string;
  task: string;
  status: string;
  attempts?: number;
  last_error?: string | null;
};

export type TopicKnowledge = {
  body: string | null;
  archives: string[];
  archiveSlug: string | null;
  projectId: string;
};

export type TopicsPaneProps = {
  active: boolean;
  topics: TopicCard[];
  tidy?: TidyProposalCard[];
  tags?: TagSuggestionCard[];
  flagged?: FlaggedJobCard[];
  busy: boolean;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onFilterData: (query: string) => void;
  onTidyDecide?: (id: string, status: "approved" | "rejected") => void;
  onTagDecide?: (id: string, status: "accepted" | "rejected") => void;
  onFlaggedRetry?: (task: string, jobKey: string) => void;
  loadKnowledge?: (topic: TopicCard) => Promise<TopicKnowledge>;
  loadArchive?: (projectId: string, slug: string, file: string) => Promise<string>;
};

type TreeRow = { topic: TopicCard; depth: number };

/** Flatten topics into a depth-first tree (≤4 levels), orphans after roots. */
export function flattenTopicTree(topics: TopicCard[]): TreeRow[] {
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const children = new Map<string, TopicCard[]>();
  const roots: TopicCard[] = [];
  for (const topic of topics) {
    const parent = topic.parent_slug?.trim() || null;
    if (parent && bySlug.has(parent) && parent !== topic.slug) {
      const list = children.get(parent) ?? [];
      list.push(topic);
      children.set(parent, list);
    } else {
      roots.push(topic);
    }
  }
  const sortFn = (a: TopicCard, b: TopicCard) => a.title.localeCompare(b.title);
  roots.sort(sortFn);
  for (const list of children.values()) list.sort(sortFn);

  const out: TreeRow[] = [];
  const walk = (topic: TopicCard, depth: number) => {
    out.push({ topic, depth: Math.min(depth, 3) });
    if (depth >= 3) return;
    for (const child of children.get(topic.slug) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return out;
}

export function TopicsPane({
  active,
  topics,
  tidy = [],
  tags = [],
  flagged = [],
  busy,
  selectedSlug,
  onSelect,
  onOpenSession,
  onFilterData,
  onTidyDecide,
  onTagDecide,
  onFlaggedRetry,
  loadKnowledge,
  loadArchive,
}: TopicsPaneProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [knowledge, setKnowledge] = useState<TopicKnowledge | null>(null);
  const [archiveFile, setArchiveFile] = useState<string | null>(null);
  const [archiveBody, setArchiveBody] = useState<string | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return topics;
    const matched = new Set(
      topics
        .filter(
          (t) =>
            t.slug.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
            (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)) ||
            (t.summary ?? "").toLowerCase().includes(q),
        )
        .map((t) => t.slug),
    );
    // Keep ancestors so the tree still reads when filtering.
    const bySlug = new Map(topics.map((t) => [t.slug, t]));
    const keep = new Set(matched);
    for (const slug of matched) {
      let cur = bySlug.get(slug);
      while (cur?.parent_slug && bySlug.has(cur.parent_slug)) {
        keep.add(cur.parent_slug);
        cur = bySlug.get(cur.parent_slug);
      }
    }
    return topics.filter((t) => keep.has(t.slug));
  }, [topics, query]);
  const tree = useMemo(() => flattenTopicTree(filtered), [filtered]);
  const selected =
    filtered.find((t) => t.slug === selectedSlug) ?? tree[0]?.topic ?? filtered[0] ?? null;

  useEffect(() => {
    let stale = false;
    setArchiveFile(null);
    setArchiveBody(null);
    setKnowledge(null);
    setKnowledgeError(null);
    if (!selected || !loadKnowledge) {
      return () => {
        stale = true;
      };
    }
    const topic = selected;
    const run = async (): Promise<void> => {
      try {
        const next = await loadKnowledge(topic);
        if (stale) {
          return;
        }
        setKnowledge(next);
      } catch (e: unknown) {
        if (stale) {
          return;
        }
        setKnowledgeError(e instanceof Error ? e.message : String(e));
      }
    };
    void run();
    return () => {
      stale = true;
    };
  }, [selected?.slug, selected?.updated_at, selected?.kind, selected?.project_id, loadKnowledge]);

  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <Panel
        className={styles.dataPage}
        title="Topics"
        lede="Nested subjects (≤4 levels), tidy proposals, tags, and dead worker jobs."
      >
        <div className={cx(styles.dataLayout, selected ? styles.hasThread : "")}>
          <div className={styles.dataListPane}>
            <div className={styles.dataSearchBar}>
              <Input
                className={styles.dataSearchInput}
                tone="plain"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter topics…"
                aria-label="Filter topics"
              />
              <span className={styles.dataSearchMeta}>
                {filtered.length}
                {busy ? " · updating" : ""}
              </span>
            </div>
            {tree.length === 0 ? (
              <div className={styles.conversationList}>
                <Empty>No topics yet — capture events and run workers to cluster subjects.</Empty>
              </div>
            ) : (
              <div className={styles.conversationList}>
                {tree.map(({ topic, depth }) => (
                  <button
                    key={topic.slug}
                    type="button"
                    className={cx(
                      styles.conversationRow,
                      selected?.slug === topic.slug && styles.active,
                    )}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                    onClick={() => onSelect(topic.slug)}
                  >
                    <div className={styles.conversationRowTop}>
                      <strong className={styles.conversationTitle}>
                        {depth > 0 ? `${"· ".repeat(depth)}` : ""}
                        {topic.title}
                      </strong>
                      {topic.curated ? <Pill tone="ok">curated</Pill> : null}
                      {topic.kind === "entity" ? <Pill>entity</Pill> : null}
                    </div>
                    <div className={styles.conversationRowMeta}>
                      <span className={styles.mono}>{topic.slug}</span>
                      <span className={styles.muted}>
                        {(topic.event_ids ?? []).length} events · {(topic.session_ids ?? []).length}{" "}
                        sessions
                      </span>
                    </div>
                    {topic.summary ? (
                      <div className={styles.conversationPreview}>{topic.summary}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={styles.dataThreadPane}>
            {!selected ? (
              <Empty>Select a topic to see sessions and citations.</Empty>
            ) : (
              <>
                <div className={styles.dataSearchBar}>
                  <div>
                    <h2 className={styles.conversationTitle}>{selected.title}</h2>
                    <div className={styles.conversationRowMeta}>
                      <span className={styles.mono}>{selected.slug}</span>
                      {selected.parent_slug ? (
                        <span className={styles.muted}>under {selected.parent_slug}</span>
                      ) : null}
                      {(selected.tags ?? []).map((tag) => (
                        <Pill key={tag}>{tag}</Pill>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.searchSegmentBtn}
                    onClick={() => onFilterData(selected.title)}
                  >
                    Search in Data
                  </button>
                </div>
                {selected.summary ? <p>{selected.summary}</p> : null}
                {knowledgeError ? <p className={styles.muted}>{knowledgeError}</p> : null}
                {knowledge?.body ? (
                  <>
                    <h3>Knowledge</h3>
                    <pre className={styles.conversationPreview}>{knowledge.body}</pre>
                    {knowledge.archives.length > 0 ? (
                      <div className={styles.wikiArchiveBar}>
                        <span className={styles.wikiArchiveLabel}>Archive</span>
                        {knowledge.archives.map((file) => (
                          <button
                            key={file}
                            type="button"
                            className={
                              archiveFile === file
                                ? `${styles.wikiArchiveChip} ${styles.wikiArchiveChipActive}`
                                : styles.wikiArchiveChip
                            }
                            onClick={() => {
                              if (!loadArchive || !knowledge.archiveSlug) {
                                return;
                              }
                              setArchiveFile(file);
                              void loadArchive(knowledge.projectId, knowledge.archiveSlug, file)
                                .then((body) => {
                                  setArchiveBody(body);
                                })
                                .catch((e: unknown) => {
                                  setKnowledgeError(e instanceof Error ? e.message : String(e));
                                });
                            }}
                          >
                            {file.replace(/\.md$/u, "")}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {archiveBody ? (
                      <pre className={styles.conversationPreview}>{archiveBody}</pre>
                    ) : null}
                  </>
                ) : null}
                {(selected.aliases ?? []).length > 0 ? (
                  <p className={styles.muted}>Aliases: {(selected.aliases ?? []).join(", ")}</p>
                ) : null}
                {(selected.decisions ?? []).length > 0 ? (
                  <>
                    <h3>Decisions</h3>
                    <ul>
                      {(selected.decisions ?? []).slice(-12).map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {tidy.length > 0 ? (
                  <>
                    <h3>Tidy proposals</h3>
                    <ul>
                      {tidy.map((p) => (
                        <li key={p.id}>
                          <span className={styles.mono}>
                            {p.action}
                            {p.from_slug ? ` ${p.from_slug}` : ""}
                            {p.to_slug ? ` → ${p.to_slug}` : ""}
                          </span>
                          <span className={styles.muted}> — {p.reason}</span>
                          {onTidyDecide ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className={styles.searchSegmentBtn}
                                onClick={() => onTidyDecide(p.id, "approved")}
                              >
                                Approve
                              </button>{" "}
                              <button
                                type="button"
                                className={styles.searchSegmentBtn}
                                onClick={() => onTidyDecide(p.id, "rejected")}
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {tags.length > 0 ? (
                  <>
                    <h3>Tag suggestions</h3>
                    <ul>
                      {tags.map((t) => (
                        <li key={t.id}>
                          <Pill>{t.tag}</Pill>{" "}
                          <span className={styles.muted}>
                            session <code>{t.session_id}</code>
                          </span>
                          {onTagDecide ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className={styles.searchSegmentBtn}
                                onClick={() => onTagDecide(t.id, "accepted")}
                              >
                                Accept
                              </button>{" "}
                              <button
                                type="button"
                                className={styles.searchSegmentBtn}
                                onClick={() => onTagDecide(t.id, "rejected")}
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {flagged.length > 0 ? (
                  <>
                    <h3>Flagged jobs</h3>
                    <ul>
                      {flagged.map((j) => (
                        <li key={`${j.task}:${j.job_key}`}>
                          <span className={styles.mono}>
                            {j.task} · {j.job_key}
                          </span>
                          {j.last_error ? (
                            <span className={styles.muted}> — {j.last_error}</span>
                          ) : null}
                          {onFlaggedRetry ? (
                            <>
                              {" "}
                              <button
                                type="button"
                                className={styles.searchSegmentBtn}
                                onClick={() => onFlaggedRetry(j.task, j.job_key)}
                              >
                                Retry
                              </button>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h3>Sessions</h3>
                {(selected.session_ids ?? []).length === 0 ? (
                  <p className={styles.muted}>No linked sessions yet.</p>
                ) : (
                  <ul>
                    {(selected.session_ids ?? []).slice(0, 40).map((sid) => (
                      <li key={sid}>
                        <button
                          type="button"
                          className={styles.searchSegmentBtn}
                          onClick={() => onOpenSession(sid)}
                        >
                          <code>{sid}</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <h3>Citations</h3>
                <p className={styles.muted}>
                  {(selected.event_ids ?? []).length} event id
                  {(selected.event_ids ?? []).length === 1 ? "" : "s"} linked in meta.
                </p>
              </>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
