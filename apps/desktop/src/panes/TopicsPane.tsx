import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Empty, Input, Panel, Pill } from "../ui";
import { cx, styles } from "#styles";
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

/** Flatten topics into a depth-first tree() (≤4 levels), orphans after roots. */
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

export function TopicsPane(props: TopicsPaneProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [knowledge, setKnowledge] = createSignal<TopicKnowledge | null>(null);
  const [archiveFile, setArchiveFile] = createSignal<string | null>(null);
  const [archiveBody, setArchiveBody] = createSignal<string | null>(null);
  const [knowledgeError, setKnowledgeError] = createSignal<string | null>(null);

  const tidy = createMemo(() => props.tidy ?? []);
  const tags = createMemo(() => props.tags ?? []);
  const flagged = createMemo(() => props.flagged ?? []);

  const filtered = createMemo(() => {
    const topics = props.topics;
    const q = query().trim().toLowerCase();
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
    // Keep ancestors so the tree() still reads when filtering.
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
  });
  const tree = createMemo(() => flattenTopicTree(filtered()));
  const selected = createMemo(
    () =>
      filtered().find((t) => t.slug === props.selectedSlug) ??
      tree()[0]?.topic ??
      filtered()[0] ??
      null,
  );

  createEffect(() => {
    let stale = false;
    const topic = selected();
    const loadKnowledge = props.loadKnowledge;
    setArchiveFile(null);
    setArchiveBody(null);
    setKnowledge(null);
    setKnowledgeError(null);
    onCleanup(() => {
      stale = true;
    });
    if (!topic || !loadKnowledge) {
      return;
    }
    void (async (): Promise<void> => {
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
    })();
  });

  return (
    <div
      class={cx(styles.viewPane, props.active ? styles.isActive : "")}
      hidden={!props.active}
      aria-hidden={!props.active}
    >
      <Panel
        class={styles.dataPage}
        title="Topics"
        lede="Nested subjects (≤4 levels), tidy proposals, tags, and dead worker jobs."
      >
        <div class={cx(styles.dataLayout, selected() ? styles.hasThread : "")}>
          <div class={styles.dataListPane}>
            <div class={styles.dataSearchBar}>
              <Input
                class={styles.dataSearchInput}
                tone="plain"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter topics…"
                aria-label="Filter topics"
              />
              <span class={styles.dataSearchMeta}>
                {filtered().length}
                {props.busy ? " · updating" : ""}
              </span>
            </div>
            <Show
              when={tree().length > 0}
              fallback={
                <div class={styles.conversationList}>
                  <Empty>No topics yet — capture events and run workers to cluster subjects.</Empty>
                </div>
              }
            >
              <div class={styles.conversationList}>
                {tree().map(({ topic, depth }) => (
                  <button
                    type="button"
                    class={cx(
                      styles.conversationRow,
                      selected()?.slug === topic.slug && styles.active,
                    )}
                    style={{ "padding-left": `${12 + depth * 16}px` }}
                    onClick={() => props.onSelect(topic.slug)}
                  >
                    <div class={styles.conversationRowTop}>
                      <strong class={styles.conversationTitle}>
                        {depth > 0 ? `${"· ".repeat(depth)}` : ""}
                        {topic.title}
                      </strong>
                      {topic.curated ? <Pill tone="ok">curated</Pill> : null}
                      {topic.kind === "entity" ? <Pill>entity</Pill> : null}
                    </div>
                    <div class={styles.conversationRowMeta}>
                      <span class={styles.mono}>{topic.slug}</span>
                      <span class={styles.muted}>
                        {(topic.event_ids ?? []).length} events · {(topic.session_ids ?? []).length}{" "}
                        sessions
                      </span>
                    </div>
                    {topic.summary ? (
                      <div class={styles.conversationPreview}>{topic.summary}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            </Show>
          </div>
          <div class={styles.dataThreadPane}>
            <Show
              when={selected()}
              fallback={<Empty>Select a topic to see sessions and citations.</Empty>}
            >
              {(sel) => (
                <>
                  <div class={styles.dataSearchBar}>
                    <div>
                      <h2 class={styles.conversationTitle}>{sel().title}</h2>
                      <div class={styles.conversationRowMeta}>
                        <span class={styles.mono}>{sel().slug}</span>
                        {sel().parent_slug ? (
                          <span class={styles.muted}>under {sel().parent_slug}</span>
                        ) : null}
                        {(sel().tags ?? []).map((tag) => (
                          <Pill>{tag}</Pill>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      class={styles.searchSegmentBtn}
                      onClick={() => props.onFilterData(sel().title)}
                    >
                      Search in Data
                    </button>
                  </div>
                  {sel().summary ? <p>{sel().summary}</p> : null}
                  {knowledgeError() ? <p class={styles.muted}>{knowledgeError()}</p> : null}
                  <Show when={knowledge()?.body}>
                    <>
                      <h3>Knowledge</h3>
                      <pre class={styles.conversationPreview}>{knowledge()?.body}</pre>
                      <Show when={(knowledge()?.archives.length ?? 0) > 0}>
                        <div class={styles.wikiArchiveBar}>
                          <span class={styles.wikiArchiveLabel}>Archive</span>
                          {(knowledge()?.archives ?? []).map((file) => (
                            <button
                              type="button"
                              class={
                                archiveFile() === file
                                  ? `${styles.wikiArchiveChip} ${styles.wikiArchiveChipActive}`
                                  : styles.wikiArchiveChip
                              }
                              onClick={() => {
                                const k = knowledge();
                                const loadArchive = props.loadArchive;
                                if (!loadArchive || !k?.archiveSlug || !k.projectId) {
                                  return;
                                }
                                setArchiveFile(file);
                                void loadArchive(k.projectId, k.archiveSlug, file)
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
                      </Show>
                      <Show when={archiveBody()}>
                        {(body) => <pre class={styles.conversationPreview}>{body()}</pre>}
                      </Show>
                    </>
                  </Show>
                  {(sel().aliases ?? []).length > 0 ? (
                    <p class={styles.muted}>Aliases: {(sel().aliases ?? []).join(", ")}</p>
                  ) : null}
                  {(sel().decisions ?? []).length > 0 ? (
                    <>
                      <h3>Decisions</h3>
                      <ul>
                        {(sel().decisions ?? []).slice(-12).map((d) => (
                          <li>{d}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <Show when={tidy().length > 0}>
                    <>
                      <h3>Tidy proposals</h3>
                      <ul>
                        {tidy().map((p) => (
                          <li>
                            <span class={styles.mono}>
                              {p.action}
                              {p.from_slug ? ` ${p.from_slug}` : ""}
                              {p.to_slug ? ` → ${p.to_slug}` : ""}
                            </span>
                            <span class={styles.muted}> — {p.reason}</span>
                            <Show when={props.onTidyDecide}>
                              {(decide) => (
                                <>
                                  {" "}
                                  <button
                                    type="button"
                                    class={styles.searchSegmentBtn}
                                    onClick={() => decide()(p.id, "approved")}
                                  >
                                    Approve
                                  </button>{" "}
                                  <button
                                    type="button"
                                    class={styles.searchSegmentBtn}
                                    onClick={() => decide()(p.id, "rejected")}
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </Show>
                          </li>
                        ))}
                      </ul>
                    </>
                  </Show>
                  <Show when={tags().length > 0}>
                    <>
                      <h3>Tag suggestions</h3>
                      <ul>
                        {tags().map((t) => (
                          <li>
                            <Pill>{t.tag}</Pill>{" "}
                            <span class={styles.muted}>
                              session <code>{t.session_id}</code>
                            </span>
                            <Show when={props.onTagDecide}>
                              {(decide) => (
                                <>
                                  {" "}
                                  <button
                                    type="button"
                                    class={styles.searchSegmentBtn}
                                    onClick={() => decide()(t.id, "accepted")}
                                  >
                                    Accept
                                  </button>{" "}
                                  <button
                                    type="button"
                                    class={styles.searchSegmentBtn}
                                    onClick={() => decide()(t.id, "rejected")}
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </Show>
                          </li>
                        ))}
                      </ul>
                    </>
                  </Show>
                  <Show when={flagged().length > 0}>
                    <>
                      <h3>Flagged jobs</h3>
                      <ul>
                        {flagged().map((j) => (
                          <li>
                            <span class={styles.mono}>
                              {j.task} · {j.job_key}
                            </span>
                            {j.last_error ? (
                              <span class={styles.muted}> — {j.last_error}</span>
                            ) : null}
                            <Show when={props.onFlaggedRetry}>
                              {(retry) => (
                                <>
                                  {" "}
                                  <button
                                    type="button"
                                    class={styles.searchSegmentBtn}
                                    onClick={() => retry()(j.task, j.job_key)}
                                  >
                                    Retry
                                  </button>
                                </>
                              )}
                            </Show>
                          </li>
                        ))}
                      </ul>
                    </>
                  </Show>
                  <h3>Sessions</h3>
                  {(sel().session_ids ?? []).length === 0 ? (
                    <p class={styles.muted}>No linked sessions yet.</p>
                  ) : (
                    <ul>
                      {(sel().session_ids ?? []).slice(0, 40).map((sid) => (
                        <li>
                          <button
                            type="button"
                            class={styles.searchSegmentBtn}
                            onClick={() => props.onOpenSession(sid)}
                          >
                            <code>{sid}</code>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>Citations</h3>
                  <p class={styles.muted}>
                    {(sel().event_ids ?? []).length} event id
                    {(sel().event_ids ?? []).length === 1 ? "" : "s"} linked in meta.
                  </p>
                </>
              )}
            </Show>
          </div>
        </div>
      </Panel>
    </div>
  );
}
