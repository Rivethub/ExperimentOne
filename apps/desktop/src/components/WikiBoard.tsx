import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Actions, Banner, Button } from "../ui";
import styles from "../styles/app.module.css";
import {
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
};

type ReaderState = {
  activeId: string | null;
  activeTitle: string;
  activePath: string;
  activeUpdated: string;
  content: string | null;
  loadingPage: boolean;
  pageError: string | null;
};

const emptyReader = (): ReaderState => ({
  activeId: null,
  activeTitle: "",
  activePath: "",
  activeUpdated: "",
  content: null,
  loadingPage: false,
  pageError: null,
});

type WikiReaderProps = {
  reader: ReaderState;
  onClose: () => void;
  onOpenFolder: () => void;
  pageList: WikiPageCard[];
  onOpenPage: (page: WikiPageCard) => void;
};

function WikiReader({
  reader,
  onClose,
  onOpenFolder,
  pageList,
  onOpenPage,
}: WikiReaderProps): ReactElement {
  return (
    <div className={styles.wikiReader}>
      <div className={styles.wikiReaderBar}>
        <button type="button" className={styles.wikiBack} onClick={onClose}>
          ← Projects
        </button>
        <div className={styles.wikiReaderMeta}>
          <strong>{reader.activeTitle}</strong>
          <span>
            {reader.activePath}
            {reader.activeUpdated !== "" ? ` · ${relativeWhen(reader.activeUpdated)}` : ""}
            {reader.loadingPage ? " · loading" : ""}
          </span>
        </div>
        <Button variant="ghost" onClick={onOpenFolder}>
          Reveal
        </Button>
      </div>
      {reader.pageError !== null && reader.pageError !== "" && (
        <Banner tone="error">{reader.pageError}</Banner>
      )}
      <article className={styles.wikiDoc}>
        <WikiReaderMarkdown
          content={reader.content ?? ""}
          activePath={reader.activePath}
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

  const projects = useMemo(
    () => buildWikiProjects(pageList, wiki?.project_id),
    [pageList, wiki?.project_id],
  );

  async function openPage(page: WikiPageCard): Promise<void> {
    setReader({
      activeId: page.id,
      activeTitle: page.title,
      activePath: page.relative_path,
      activeUpdated: page.updated_at,
      content: ensureReadmeToc(page.preview, page.relative_path, page.project_id, pageList),
      pageError: null,
      loadingPage: true,
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
