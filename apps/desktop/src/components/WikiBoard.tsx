import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Actions, Banner, Button } from "../ui";
import styles from "../styles/app.module.css";
import {
  archiveSlugForPage,
  buildWikiProjects,
  ensureReadmeToc,
  relativeWhen,
  coverTone,
} from "./wiki-board-logic";
import { WikiReaderMarkdown, WikiTilePreviewMarkdown } from "./wiki-reader-markdown";

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

function WikiReader({
  reader,
  onClose,
  onOpenFolder,
  pageList,
  onOpenPage,
  onOpenArchive,
  onCloseArchive,
}: WikiReaderProps): ReactElement {
  const viewingArchive = reader.archiveFile !== null;
  const docContent = viewingArchive
    ? (reader.archiveContent ?? "")
    : (reader.content ?? "");
  return (
    <div className={styles.wikiReader}>
      <div className={styles.wikiReaderBar}>
        <button type="button" className={styles.wikiBack} onClick={onClose}>
          ← Projects
        </button>
        <div className={styles.wikiReaderMeta}>
          <strong>
            {viewingArchive
              ? `${reader.activeTitle} · ${reader.archiveFile}`
              : reader.activeTitle}
          </strong>
          <span>
            {viewingArchive
              ? `archive/${reader.archiveSlug}/${reader.archiveFile}`
              : reader.activePath}
            {!viewingArchive && reader.activeUpdated !== ""
              ? ` · ${relativeWhen(reader.activeUpdated)}`
              : ""}
            {reader.loadingPage || reader.archiveLoading ? " · loading" : ""}
          </span>
        </div>
        {viewingArchive ? (
          <Button variant="ghost" onClick={onCloseArchive}>
            Live page
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onOpenFolder}>
          Reveal
        </Button>
      </div>
      {reader.archiveFiles.length > 0 ? (
        <div className={styles.wikiArchiveBar} role="navigation" aria-label="Archive segments">
          <span className={styles.wikiArchiveLabel}>Archive</span>
          {reader.archiveFiles.map((file) => (
            <button
              key={file}
              type="button"
              className={
                reader.archiveFile === file
                  ? `${styles.wikiArchiveChip} ${styles.wikiArchiveChipActive}`
                  : styles.wikiArchiveChip
              }
              onClick={() => {
                onOpenArchive(file);
              }}
            >
              {file.replace(/\.md$/u, "")}
            </button>
          ))}
        </div>
      ) : null}
      {(reader.pageError !== null && reader.pageError !== "") ||
      (reader.archiveError !== null && reader.archiveError !== "") ? (
        <Banner tone="error">{reader.archiveError || reader.pageError}</Banner>
      ) : null}
      <article className={styles.wikiDoc}>
        <WikiReaderMarkdown
          content={docContent}
          activePath={
            viewingArchive
              ? `archive/${reader.archiveSlug}/${reader.archiveFile}`
              : reader.activePath
          }
          pageList={pageList}
          onOpenPage={onOpenPage}
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

function WikiProjectGrid({
  projects,
  busy,
  wikiEnabled,
  onEnable,
  onOpenFolder,
  onOpenPage,
}: WikiGridProps): ReactElement {
  if (projects.length === 0) {
    return (
      <div className={styles.wikiEmpty}>
        <div className={styles.wikiEmptyCard}>
          <strong>No project README yet</strong>
          <p>Enable the wiki worker or add a README.md to the project folder.</p>
          <Actions>
            <Button variant="primary" disabled={busy} onClick={onEnable}>
              {wikiEnabled ? "Open Settings" : "Enable in Settings"}
            </Button>
            <Button onClick={onOpenFolder}>Open folder</Button>
          </Actions>
        </div>
      </div>
    );
  }

  return (
    <section className={styles.wikiSection}>
      <div className={styles.wikiGrid}>
        {projects.map(({ projectId, label, readme }) => {
          const hue = coverTone(`${projectId}/${label}`);
          const preview = readme.preview !== "" ? readme.preview : "_Empty README_";
          return (
            <button
              key={projectId}
              type="button"
              className={styles.wikiTile}
              aria-label={`Open ${label} README`}
              onClick={() => {
                onOpenPage(readme);
              }}
            >
              <div
                className={styles.wikiTileCover}
                style={{
                  background: `linear-gradient(160deg, hsl(${hue} 28% 14%) 0%, hsl(${hue} 18% 8%) 100%)`,
                }}
              >
                <div className={styles.wikiTilePreview} aria-hidden>
                  <WikiTilePreviewMarkdown preview={preview} />
                </div>
              </div>
              <div className={styles.wikiTileFoot}>
                <strong>{label}</strong>
                <span>
                  README.md
                  <em>· {relativeWhen(readme.updated_at)}</em>
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function WikiBoard({
  wiki,
  busy,
  wikiEnabled,
  onOpenFolder,
  onEnable,
  loadPage,
  listArchives,
  loadArchive,
}: WikiBoardProps): ReactElement {
  const [reader, setReader] = useState<ReaderState>(emptyReader);

  const pageList = useMemo(() => wiki?.pages ?? [], [wiki?.pages]);

  useEffect(() => {
    let stale = false;

    if (reader.activeId === null) {
      return () => {
        stale = true;
      };
    }
    const page = pageList.find((p) => p.id === reader.activeId);
    if (!page) {
      setReader(emptyReader());
      return () => {
        stale = true;
      };
    }
    if (page.updated_at === reader.activeUpdated) {
      return () => {
        stale = true;
      };
    }
    const reload = async (): Promise<void> => {
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
          content: ensureReadmeToc(full, page.relative_path, page.project_id, pageList),
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
    };
    void reload();
    return () => {
      stale = true;
    };
  }, [pageList, reader.activeId, reader.activeUpdated, loadPage]);

  useEffect(() => {
    let stale = false;
    if (reader.activeId === null || !listArchives) {
      return () => {
        stale = true;
      };
    }
    const page = pageList.find((p) => p.id === reader.activeId);
    if (!page) {
      return () => {
        stale = true;
      };
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
      return () => {
        stale = true;
      };
    }
    const load = async (): Promise<void> => {
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
    };
    void load();
    return () => {
      stale = true;
    };
  }, [pageList, reader.activeId, listArchives]);

  const projects = useMemo(
    () => buildWikiProjects(pageList, wiki?.project_id),
    [pageList, wiki?.project_id],
  );

  async function openPage(page: WikiPageCard): Promise<void> {
    setReader({
      ...emptyReader(),
      activeId: page.id,
      activeTitle: page.title,
      activePath: page.relative_path,
      activeUpdated: page.updated_at,
      content: ensureReadmeToc(page.preview, page.relative_path, page.project_id, pageList),
      loadingPage: true,
      archiveSlug: archiveSlugForPage(page),
    });
    try {
      const full = await loadPage(page);
      setReader((prev) => ({
        ...prev,
        content: ensureReadmeToc(full, page.relative_path, page.project_id, pageList),
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
    if (!loadArchive || reader.archiveSlug === null || reader.activeId === null) {
      return;
    }
    const page = pageList.find((p) => p.id === reader.activeId);
    if (!page) {
      return;
    }
    setReader((prev) => ({
      ...prev,
      archiveFile: file,
      archiveLoading: true,
      archiveError: null,
    }));
    try {
      const content = await loadArchive(page.project_id, reader.archiveSlug, file);
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

  if (reader.activeId !== null) {
    return (
      <WikiReader
        reader={reader}
        onClose={() => {
          setReader(emptyReader());
        }}
        onOpenFolder={onOpenFolder}
        pageList={pageList}
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
    );
  }

  return (
    <div className={styles.wikiBoard}>
      <p className={styles.wikiBoardLede}>One README per project — open it, then follow links.</p>
      <WikiProjectGrid
        projects={projects}
        busy={busy}
        wikiEnabled={wikiEnabled}
        onEnable={onEnable}
        onOpenFolder={onOpenFolder}
        onOpenPage={(p) => {
          void openPage(p);
        }}
      />
    </div>
  );
}
