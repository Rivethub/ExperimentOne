import { createStore } from "solid-js/store";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Alert, AlertDescription } from "#components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "#components/ui/card";
import { Actions, Button, Panel } from "../ui";
import {
  archiveSlugForPage,
  buildWikiProjects,
  ensureReadmeToc,
  relativeWhen,
  coverTone,
  topicSlugFromWikiPage,
} from "./wiki-board-logic";
import { WikiReaderMarkdown, WikiTilePreviewMarkdown } from "./wiki-reader-markdown";
import { styles } from "#styles";

export type WikiPageCard = {
  id: string;
  project_id: string;
  title: string;
  path: string;
  relative_path: string;
  folder: string;
  updated_at: string;
  preview: string;
};

export type WikiInfo = {
  path: string;
  project_id: string;
  revision?: number;
  pages: WikiPageCard[];
};

type WikiBoardProps = {
  wiki: WikiInfo | null;
  busy: boolean;
  wikiEnabled: boolean;
  /** Deep-link page id (`project/topics/slug`) from `/wiki?page=…`. */
  initialPageId?: string | null;
  onOpenFolder: () => void;
  onEnable: () => void;
  onOpenTopic?: (slug: string) => void;
  onBrowseTopics?: () => void;
  /** Clear `/wiki?page=` after the reader is closed or the deep link is applied. */
  onClearInitialPage?: () => void;
  loadPage: (page: WikiPageCard) => Promise<string>;
  listArchives?: (projectId: string, slug: string) => Promise<string[]>;
  loadArchive?: (projectId: string, slug: string, file: string) => Promise<string>;
};

type ReaderState = {
  activeId: string | null;
  activeTitle: string;
  activePath: string;
  activeUpdated: string;
  content: string | null;
  loadingPage: boolean;
  pageError: string | null;
  archiveSlug: string | null;
  archiveFiles: string[];
  archiveFile: string | null;
  archiveContent: string | null;
  archiveLoading: boolean;
  archiveError: string | null;
};

const emptyReader = (): ReaderState => ({
  activeId: null,
  activeTitle: "",
  activePath: "",
  activeUpdated: "",
  content: null,
  loadingPage: false,
  pageError: null,
  archiveSlug: null,
  archiveFiles: [],
  archiveFile: null,
  archiveContent: null,
  archiveLoading: false,
  archiveError: null,
});

type WikiReaderProps = {
  reader: ReaderState;
  topicSlug: string | null;
  onClose: () => void;
  onOpenFolder: () => void;
  onOpenTopic?: (slug: string) => void;
  pageList: WikiPageCard[];
  onOpenPage: (page: WikiPageCard) => void;
  onOpenArchive: (file: string) => void;
  onCloseArchive: () => void;
};

function WikiReader(props: WikiReaderProps): JSX.Element {
  const viewingArchive = createMemo(() => props.reader.archiveFile !== null);
  const docContent = createMemo(() =>
    viewingArchive() ? (props.reader.archiveContent ?? "") : (props.reader.content ?? ""),
  );
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div class="min-w-0 flex-1">
          <Button variant="ghost" onClick={() => props.onClose()}>
            ← Projects
          </Button>
          <div class="mt-1 min-w-0">
            <strong class="block truncate text-sm">
              {viewingArchive()
                ? `${props.reader.activeTitle} · ${props.reader.archiveFile}`
                : props.reader.activeTitle}
            </strong>
            <span class="block truncate text-xs text-muted-foreground">
              {viewingArchive()
                ? `archive/${props.reader.archiveSlug}/${props.reader.archiveFile}`
                : props.reader.activePath}
              {!viewingArchive() && props.reader.activeUpdated !== ""
                ? ` · ${relativeWhen(props.reader.activeUpdated)}`
                : ""}
              {props.reader.loadingPage || props.reader.archiveLoading ? " · loading" : ""}
            </span>
          </div>
        </div>
        <Show when={viewingArchive()}>
          <Button variant="ghost" onClick={() => props.onCloseArchive()}>
            Live page
          </Button>
        </Show>
        <Show when={props.topicSlug}>
          {(slug) => (
            <Show when={props.onOpenTopic}>
              {(openTopic) => (
                <Button variant="ghost" onClick={() => openTopic()(slug())}>
                  Open in Topics
                </Button>
              )}
            </Show>
          )}
        </Show>
        <Button variant="ghost" onClick={() => props.onOpenFolder()}>
          Reveal
        </Button>
      </div>
      <Show when={props.reader.archiveFiles.length > 0}>
        <div class={styles.wikiArchiveBar} role="navigation" aria-label="Archive segments">
          <span class={styles.wikiArchiveLabel}>Archive</span>
          {props.reader.archiveFiles.map((file) => (
            <button
              type="button"
              class={
                props.reader.archiveFile === file
                  ? `${styles.wikiArchiveChip} ${styles.wikiArchiveChipActive}`
                  : styles.wikiArchiveChip
              }
              onClick={() => {
                props.onOpenArchive(file);
              }}
            >
              {file.replace(/\.md$/u, "")}
            </button>
          ))}
        </div>
      </Show>
      <Show
        when={
          (props.reader.pageError !== null && props.reader.pageError !== "") ||
          (props.reader.archiveError !== null && props.reader.archiveError !== "")
        }
      >
        <Alert variant="destructive" class="mx-4 mt-3">
          <AlertDescription>{props.reader.archiveError || props.reader.pageError}</AlertDescription>
        </Alert>
      </Show>
      <article class={styles.wikiDoc}>
        <WikiReaderMarkdown
          content={docContent()}
          activePath={
            viewingArchive()
              ? `archive/${props.reader.archiveSlug}/${props.reader.archiveFile}`
              : props.reader.activePath
          }
          pageList={props.pageList}
          onOpenPage={props.onOpenPage}
        />
      </article>
    </div>
  );
}

type WikiEmptyProps = {
  busy: boolean;
  wikiEnabled: boolean;
  pageCount: number;
  onEnable: () => void;
  onOpenFolder: () => void;
  onOpenTopics?: () => void;
};

function WikiEmptyState(props: WikiEmptyProps): JSX.Element {
  const title = () => {
    if (!props.wikiEnabled) return "Wiki worker is off";
    if (props.pageCount > 0) return "No project README yet";
    return "Wiki is empty";
  };
  const lede = () => {
    if (!props.wikiEnabled) {
      return "Turn on the wiki worker so Rivet can build a README for each project from captures.";
    }
    if (props.pageCount > 0) {
      return "Pages are on disk, but none have a project-root README.md to open from this board.";
    }
    return "When the wiki worker runs, each project gets a README you can open and follow links from.";
  };
  const nextStep = () => {
    if (!props.wikiEnabled) {
      return "Enable the worker under Settings → Workers, keep the proxy capturing, then come back here.";
    }
    if (props.pageCount > 0) {
      return "Add or generate a README.md at the project root, or open the wiki folder to inspect what’s already there.";
    }
    return "Capture some sessions through the proxy, then let the wiki worker draft the first README.";
  };

  return (
    <div class="flex min-h-0 flex-1 items-center justify-center px-4 py-8 md:px-6">
      <Panel
        class="mb-0 w-full max-w-lg"
        title={title()}
        lede={lede()}
        actions={
          <Button variant="primary" disabled={props.busy} onClick={() => props.onEnable()}>
            {props.wikiEnabled ? "Open Settings" : "Enable wiki"}
          </Button>
        }
      >
        <p class="m-0 max-w-[56ch] text-[13px] leading-snug text-muted-foreground">{nextStep()}</p>
        <Actions spaced={false} class="mt-3.5">
          <Button onClick={() => props.onOpenFolder()}>Open folder</Button>
          <Show when={props.onOpenTopics}>
            {(openTopics) => (
              <Button variant="ghost" onClick={() => openTopics()()}>
                Browse Topics
              </Button>
            )}
          </Show>
        </Actions>
      </Panel>
    </div>
  );
}

type WikiGridProps = {
  projects: ReturnType<typeof buildWikiProjects>;
  onOpenPage: (page: WikiPageCard) => void;
};

function WikiProjectGrid(props: WikiGridProps): JSX.Element {
  return (
    <section>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {props.projects.map(({ projectId, label, readme }) => {
          const hue = coverTone(`${projectId}/${label}`);
          const preview = readme.preview !== "" ? readme.preview : "_Empty README_";
          return (
            <button
              type="button"
              class="group rounded-xl text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Open ${label} README`}
              onClick={() => {
                props.onOpenPage(readme);
              }}
            >
              <Card class="gap-0 overflow-hidden py-0 shadow-none transition group-hover:bg-secondary/20">
                <div
                  class="relative h-40 overflow-hidden px-3.5 py-3"
                  style={{
                    background: `linear-gradient(160deg, hsl(${hue} 28% 14%) 0%, hsl(${hue} 18% 8%) 100%)`,
                  }}
                >
                  <div
                    class="pointer-events-none origin-top-left scale-[0.55] text-[11px] leading-snug text-muted-foreground/90 opacity-90"
                    aria-hidden
                  >
                    <WikiTilePreviewMarkdown preview={preview} />
                  </div>
                </div>
                <CardHeader class="gap-1 border-t border-border px-3.5 py-2.5">
                  <CardTitle class="truncate text-sm">{label}</CardTitle>
                  <CardDescription class="truncate text-xs">
                    README.md
                    <em class="not-italic opacity-80"> · {relativeWhen(readme.updated_at)}</em>
                  </CardDescription>
                </CardHeader>
              </Card>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function WikiBoard(props: WikiBoardProps): JSX.Element {
  const [reader, setReader] = createStore<ReaderState>(emptyReader());
  const [openedInitialPage, setOpenedInitialPage] = createSignal<string | null>(null);

  const pageList = createMemo(() => props.wiki?.pages ?? []);
  const projects = createMemo(() => buildWikiProjects(pageList(), props.wiki?.project_id));
  const activeTopicSlug = createMemo(() => {
    const id = reader.activeId;
    if (id === null) return null;
    const page = pageList().find((p) => p.id === id);
    return page ? topicSlugFromWikiPage(page) : null;
  });

  createEffect(() => {
    const pageId = props.initialPageId?.trim() || "";
    if (pageId === "" || openedInitialPage() === pageId) return;
    const page = pageList().find((p) => p.id === pageId);
    if (!page) return;
    setOpenedInitialPage(pageId);
    void openPage(page);
    props.onClearInitialPage?.();
  });

  createEffect(() => {
    let stale = false;
    const activeId = reader.activeId;
    const pages = pageList();
    const loadPage = props.loadPage;
    onCleanup(() => {
      stale = true;
    });

    if (activeId === null) {
      return;
    }
    const page = pages.find((p) => p.id === activeId);
    if (!page) {
      setReader(emptyReader());
      return;
    }
    if (page.updated_at === reader.activeUpdated) {
      return;
    }
    void (async (): Promise<void> => {
      setReader((prev) => ({
        ...prev,
        activeTitle: page.title,
        activePath: page.relative_path,
        activeUpdated: page.updated_at,
        loadingPage: true,
      }));
      try {
        const full = await loadPage(page);
        if (stale) {
          return;
        }
        setReader((prev) => ({
          ...prev,
          content: ensureReadmeToc(full, page.relative_path, page.project_id, pageList()),
          pageError: null,
          loadingPage: false,
        }));
      } catch (e: unknown) {
        if (stale) {
          return;
        }
        setReader((prev) => ({
          ...prev,
          pageError: e instanceof Error ? e.message : String(e),
          loadingPage: false,
        }));
      }
    })();
  });

  createEffect(() => {
    let stale = false;
    const activeId = reader.activeId;
    const listArchives = props.listArchives;
    const pages = pageList();
    onCleanup(() => {
      stale = true;
    });

    if (activeId === null || !listArchives) {
      return;
    }
    const page = pages.find((p) => p.id === activeId);
    if (!page) {
      return;
    }
    const slug = archiveSlugForPage(page);
    if (!slug) {
      setReader((prev) => ({
        ...prev,
        archiveSlug: null,
        archiveFiles: [],
        archiveFile: null,
        archiveContent: null,
        archiveError: null,
      }));
      return;
    }
    void (async (): Promise<void> => {
      try {
        const files = await listArchives(page.project_id, slug);
        if (stale) {
          return;
        }
        setReader((prev) => ({
          ...prev,
          archiveSlug: slug,
          archiveFiles: files,
          archiveError: null,
        }));
      } catch (e: unknown) {
        if (stale) {
          return;
        }
        setReader((prev) => ({
          ...prev,
          archiveSlug: slug,
          archiveFiles: [],
          archiveError: e instanceof Error ? e.message : String(e),
        }));
      }
    })();
  });

  async function openPage(page: WikiPageCard): Promise<void> {
    setReader({
      ...emptyReader(),
      activeId: page.id,
      activeTitle: page.title,
      activePath: page.relative_path,
      activeUpdated: page.updated_at,
      content: ensureReadmeToc(page.preview, page.relative_path, page.project_id, pageList()),
      loadingPage: true,
      archiveSlug: archiveSlugForPage(page),
    });
    try {
      const full = await props.loadPage(page);
      setReader((prev) => ({
        ...prev,
        content: ensureReadmeToc(full, page.relative_path, page.project_id, pageList()),
        loadingPage: false,
      }));
    } catch (e: unknown) {
      setReader((prev) => ({
        ...prev,
        pageError: e instanceof Error ? e.message : String(e),
        loadingPage: false,
      }));
    }
  }

  async function openArchive(file: string): Promise<void> {
    const loadArchive = props.loadArchive;
    if (!loadArchive || reader.archiveSlug === null || reader.activeId === null) {
      return;
    }
    const page = pageList().find((p) => p.id === reader.activeId);
    if (!page) {
      return;
    }
    const archiveSlug = reader.archiveSlug;
    setReader((prev) => ({
      ...prev,
      archiveFile: file,
      archiveLoading: true,
      archiveError: null,
    }));
    try {
      const content = await loadArchive(page.project_id, archiveSlug, file);
      setReader((prev) => ({
        ...prev,
        archiveContent: content,
        archiveLoading: false,
      }));
    } catch (e: unknown) {
      setReader((prev) => ({
        ...prev,
        archiveError: e instanceof Error ? e.message : String(e),
        archiveLoading: false,
      }));
    }
  }

  return (
    <Show
      when={reader.activeId !== null}
      fallback={
        <Show
          when={projects().length > 0}
          fallback={
            <WikiEmptyState
              busy={props.busy}
              wikiEnabled={props.wikiEnabled}
              pageCount={pageList().length}
              onEnable={() => props.onEnable()}
              onOpenFolder={() => props.onOpenFolder()}
              onOpenTopics={props.onBrowseTopics}
            />
          }
        >
          <div class="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 md:px-6">
            <p class="mb-4 max-w-[68ch] text-[13px] text-muted-foreground">
              One README per project — open it, then follow links. Topic pages can jump to Topics.
            </p>
            <WikiProjectGrid
              projects={projects()}
              onOpenPage={(p) => {
                void openPage(p);
              }}
            />
          </div>
        </Show>
      }
    >
      <WikiReader
        reader={reader}
        topicSlug={activeTopicSlug()}
        onClose={() => {
          setReader(emptyReader());
          props.onClearInitialPage?.();
        }}
        onOpenFolder={() => props.onOpenFolder()}
        onOpenTopic={props.onOpenTopic}
        pageList={pageList()}
        onOpenPage={(p) => {
          void openPage(p);
        }}
        onOpenArchive={(file) => {
          void openArchive(file);
        }}
        onCloseArchive={() => {
          setReader((prev) => ({
            ...prev,
            archiveFile: null,
            archiveContent: null,
            archiveError: null,
          }));
        }}
      />
    </Show>
  );
}
