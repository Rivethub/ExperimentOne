import { createStore } from "solid-js/store";
import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Alert, AlertDescription } from "#components/ui/alert";
import { Actions, Button, Panel } from "../ui";
import {
  archiveSlugForPage,
  buildWikiProjects,
  ensureReadmeToc,
  relativeWhen,
  coverTone,
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
  onOpenFolder: () => void;
  onEnable: () => void;
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
  onClose: () => void;
  onOpenFolder: () => void;
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

type WikiGridProps = {
  projects: ReturnType<typeof buildWikiProjects>;
  busy: boolean;
  wikiEnabled: boolean;
  onEnable: () => void;
  onOpenFolder: () => void;
  onOpenPage: (page: WikiPageCard) => void;
};

function WikiProjectGrid(props: WikiGridProps): JSX.Element {
  return (
    <Show
      when={props.projects.length > 0}
      fallback={
        <Panel
          class="mx-auto mb-0 max-w-md"
          title="No project README yet"
          lede="Enable the wiki worker or add a README.md to the project folder."
        >
          <Actions spaced={false}>
            <Button variant="primary" disabled={props.busy} onClick={() => props.onEnable()}>
              {props.wikiEnabled ? "Open Settings" : "Enable in Settings"}
            </Button>
            <Button onClick={() => props.onOpenFolder()}>Open folder</Button>
          </Actions>
        </Panel>
      }
    >
      <section>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {props.projects.map(({ projectId, label, readme }) => {
            const hue = coverTone(`${projectId}/${label}`);
            const preview = readme.preview !== "" ? readme.preview : "_Empty README_";
            return (
              <button
                type="button"
                class="group overflow-hidden rounded-xl border border-border bg-card text-left transition hover:border-border/90 hover:bg-secondary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${label} README`}
                onClick={() => {
                  props.onOpenPage(readme);
                }}
              >
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
                <div class="border-t border-border px-3.5 py-2.5">
                  <strong class="block truncate text-sm">{label}</strong>
                  <span class="mt-0.5 block truncate text-xs text-muted-foreground">
                    README.md
                    <em class="not-italic opacity-80"> · {relativeWhen(readme.updated_at)}</em>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </Show>
  );
}

export function WikiBoard(props: WikiBoardProps): JSX.Element {
  const [reader, setReader] = createStore<ReaderState>(emptyReader());

  const pageList = createMemo(() => props.wiki?.pages ?? []);
  const projects = createMemo(() => buildWikiProjects(pageList(), props.wiki?.project_id));

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
        <div class="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-4">
          <p class="mb-4 max-w-[68ch] text-[13px] text-muted-foreground">
            One README per project — open it, then follow links.
          </p>
          <WikiProjectGrid
            projects={projects()}
            busy={props.busy}
            wikiEnabled={props.wikiEnabled}
            onEnable={() => props.onEnable()}
            onOpenFolder={() => props.onOpenFolder()}
            onOpenPage={(p) => {
              void openPage(p);
            }}
          />
        </div>
      }
    >
      <WikiReader
        reader={reader}
        onClose={() => {
          setReader(emptyReader());
        }}
        onOpenFolder={() => props.onOpenFolder()}
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
