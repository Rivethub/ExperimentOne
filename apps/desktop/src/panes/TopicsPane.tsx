import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "#components/ui/button";
import { cn } from "#lib/utils";
import { Empty, Input, Panel, Pill } from "../ui";

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
      class={cn("flex min-h-0 min-w-0 flex-1 flex-col", !props.active && "hidden")}
      hidden={!props.active}
      aria-hidden={!props.active}
    >
      <Panel
        class="mb-0 flex min-h-0 flex-1 flex-col"
        title="Topics"
        lede="Nested subjects (≤4 levels), tidy proposals, tags, and dead worker jobs."
      >
        <div
          class={cn(
            "mt-3.5 grid min-h-0 flex-1 gap-3",
            selected()
              ? "grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(0,1.4fr)]"
              : "grid-cols-1",
          )}
        >
          <div class="flex min-h-0 min-w-0 flex-col">
            <div class="flex min-w-0 items-center gap-2">
              <Input
                class="min-w-0 flex-1"
                tone="plain"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter topics…"
                aria-label="Filter topics"
              />
              <span class="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                {filtered().length}
                {props.busy ? " · updating" : ""}
              </span>
            </div>
            <Show
              when={tree().length > 0}
              fallback={
                <div class="mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60">
                  <Empty>No topics yet — capture events and run workers to cluster subjects.</Empty>
                </div>
              }
            >
              <div class="mt-3 min-h-0 flex-1 overflow-auto rounded-[10px] border border-border/60">
                <For each={tree()}>
                  {({ topic, depth }) => (
                    <button
                      type="button"
                      class={cn(
                        "flex w-full cursor-pointer flex-col gap-1.5 border-0 border-b border-border/60 bg-transparent px-3.5 py-3 text-left text-foreground",
                        "hover:bg-accent",
                        selected()?.slug === topic.slug && "bg-secondary",
                      )}
                      style={{ "padding-left": `${14 + depth * 16}px` }}
                      onClick={() => props.onSelect(topic.slug)}
                    >
                      <div class="flex items-baseline justify-between gap-2.5">
                        <strong class="truncate text-[13px] font-semibold">
                          {depth > 0 ? `${"· ".repeat(depth)}` : ""}
                          {topic.title}
                        </strong>
                        <div class="flex shrink-0 gap-1">
                          <Show when={topic.curated}>
                            <Pill tone="ok">curated</Pill>
                          </Show>
                          <Show when={topic.kind === "entity"}>
                            <Pill>entity</Pill>
                          </Show>
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span class="font-mono text-xs">{topic.slug}</span>
                        <span>
                          {(topic.event_ids ?? []).length} events ·{" "}
                          {(topic.session_ids ?? []).length} sessions
                        </span>
                      </div>
                      <Show when={topic.summary}>
                        {(summary) => (
                          <div class="truncate text-xs text-muted-foreground">{summary()}</div>
                        )}
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="bg-card/40 flex min-h-0 min-w-0 flex-col overflow-auto rounded-[10px] border border-border/60 p-3.5">
            <Show
              when={selected()}
              fallback={<Empty>Select a topic to see sessions and citations.</Empty>}
            >
              {(sel) => (
                <div class="flex min-h-0 flex-col gap-3">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <h2 class="m-0 truncate text-sm font-semibold">{sel().title}</h2>
                      <div class="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span class="font-mono text-xs">{sel().slug}</span>
                        <Show when={sel().parent_slug}>
                          {(parent) => <span>under {parent()}</span>}
                        </Show>
                        <For each={sel().tags ?? []}>{(tag) => <Pill>{tag}</Pill>}</For>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => props.onFilterData(sel().title)}
                    >
                      Search in Data
                    </Button>
                  </div>

                  <Show when={sel().summary}>
                    {(summary) => <p class="m-0 text-sm">{summary()}</p>}
                  </Show>
                  <Show when={knowledgeError()}>
                    {(err) => <p class="m-0 text-sm text-muted-foreground">{err()}</p>}
                  </Show>

                  <Show when={knowledge()?.body}>
                    {(body) => (
                      <>
                        <h3 class="m-0 text-sm font-semibold">Knowledge</h3>
                        <pre class="m-0 max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs whitespace-pre-wrap">
                          {body()}
                        </pre>
                        <Show when={(knowledge()?.archives.length ?? 0) > 0}>
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-muted-foreground">Archive</span>
                            <For each={knowledge()?.archives ?? []}>
                              {(file) => (
                                <Button
                                  variant={archiveFile() === file ? "secondary" : "outline"}
                                  size="sm"
                                  class="h-7 text-xs"
                                  onClick={() => {
                                    const k = knowledge();
                                    const loadArchive = props.loadArchive;
                                    if (!loadArchive || !k?.archiveSlug || !k.projectId) {
                                      return;
                                    }
                                    setArchiveFile(file);
                                    void loadArchive(k.projectId, k.archiveSlug, file)
                                      .then((next) => {
                                        setArchiveBody(next);
                                      })
                                      .catch((e: unknown) => {
                                        setKnowledgeError(
                                          e instanceof Error ? e.message : String(e),
                                        );
                                      });
                                  }}
                                >
                                  {file.replace(/\.md$/u, "")}
                                </Button>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={archiveBody()}>
                          {(archive) => (
                            <pre class="m-0 max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs whitespace-pre-wrap">
                              {archive()}
                            </pre>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>

                  <Show when={(sel().aliases ?? []).length > 0}>
                    <p class="m-0 text-sm text-muted-foreground">
                      Aliases: {(sel().aliases ?? []).join(", ")}
                    </p>
                  </Show>

                  <Show when={(sel().decisions ?? []).length > 0}>
                    <>
                      <h3 class="m-0 text-sm font-semibold">Decisions</h3>
                      <ul class="m-0 list-disc space-y-1 pl-5 text-sm">
                        <For each={(sel().decisions ?? []).slice(-12)}>{(d) => <li>{d}</li>}</For>
                      </ul>
                    </>
                  </Show>

                  <Show when={tidy().length > 0}>
                    <>
                      <h3 class="m-0 text-sm font-semibold">Tidy proposals</h3>
                      <ul class="m-0 space-y-2 text-sm">
                        <For each={tidy()}>
                          {(p) => (
                            <li class="flex flex-wrap items-center gap-2">
                              <span class="font-mono text-xs">
                                {p.action}
                                {p.from_slug ? ` ${p.from_slug}` : ""}
                                {p.to_slug ? ` → ${p.to_slug}` : ""}
                              </span>
                              <span class="text-muted-foreground">— {p.reason}</span>
                              <Show when={props.onTidyDecide}>
                                {(decide) => (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      class="h-7"
                                      onClick={() => decide()(p.id, "approved")}
                                    >
                                      Approve
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      class="h-7"
                                      onClick={() => decide()(p.id, "rejected")}
                                    >
                                      Reject
                                    </Button>
                                  </>
                                )}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </>
                  </Show>

                  <Show when={tags().length > 0}>
                    <>
                      <h3 class="m-0 text-sm font-semibold">Tag suggestions</h3>
                      <ul class="m-0 space-y-2 text-sm">
                        <For each={tags()}>
                          {(t) => (
                            <li class="flex flex-wrap items-center gap-2">
                              <Pill>{t.tag}</Pill>
                              <span class="text-muted-foreground">
                                session <code>{t.session_id}</code>
                              </span>
                              <Show when={props.onTagDecide}>
                                {(decide) => (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      class="h-7"
                                      onClick={() => decide()(t.id, "accepted")}
                                    >
                                      Accept
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      class="h-7"
                                      onClick={() => decide()(t.id, "rejected")}
                                    >
                                      Reject
                                    </Button>
                                  </>
                                )}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </>
                  </Show>

                  <Show when={flagged().length > 0}>
                    <>
                      <h3 class="m-0 text-sm font-semibold">Flagged jobs</h3>
                      <ul class="m-0 space-y-2 text-sm">
                        <For each={flagged()}>
                          {(j) => (
                            <li class="flex flex-wrap items-center gap-2">
                              <span class="font-mono text-xs">
                                {j.task} · {j.job_key}
                              </span>
                              <Show when={j.last_error}>
                                {(err) => <span class="text-muted-foreground">— {err()}</span>}
                              </Show>
                              <Show when={props.onFlaggedRetry}>
                                {(retry) => (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-7"
                                    onClick={() => retry()(j.task, j.job_key)}
                                  >
                                    Retry
                                  </Button>
                                )}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </>
                  </Show>

                  <h3 class="m-0 text-sm font-semibold">Sessions</h3>
                  <Show
                    when={(sel().session_ids ?? []).length > 0}
                    fallback={
                      <p class="m-0 text-sm text-muted-foreground">No linked sessions yet.</p>
                    }
                  >
                    <ul class="m-0 space-y-1">
                      <For each={(sel().session_ids ?? []).slice(0, 40)}>
                        {(sid) => (
                          <li>
                            <Button
                              variant="ghost"
                              size="sm"
                              class="h-7 px-2 font-mono text-xs"
                              onClick={() => props.onOpenSession(sid)}
                            >
                              {sid}
                            </Button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>

                  <h3 class="m-0 text-sm font-semibold">Citations</h3>
                  <p class="m-0 text-sm text-muted-foreground">
                    {(sel().event_ids ?? []).length} event id
                    {(sel().event_ids ?? []).length === 1 ? "" : "s"} linked in meta.
                  </p>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Panel>
    </div>
  );
}
