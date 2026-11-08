import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Actions, Banner, Button } from "../ui";
import styles from "../styles/app.module.css";

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

type ProjectEntry = {
  projectId: string;
  label: string;
  readme: WikiPageCard;
};

function relativeWhen(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 14) return `${Math.round(sec / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

function coverTone(key: string) {
  let hash = 0;
  const s = key.toLowerCase();
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const hues = [24, 210, 158, 280, 190, 45, 330];
  return hues[hash % hues.length];
}

function isReadme(page: WikiPageCard) {
  return /(^|\/)README\.md$/i.test(page.relative_path);
}

function projectLabel(projectId: string, readme: WikiPageCard) {
  const id = projectId.trim();
  if (id && id.toLowerCase() !== "default") return id;
  const title = readme.title?.trim();
  if (title && title.toLowerCase() !== "readme") return title;
  return "Project";
}

function normalizeWikiPath(raw: string) {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function joinWikiPath(baseDir: string, href: string) {
  const parts = [...(baseDir ? baseDir.split("/") : []), ...normalizeWikiPath(href).split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

function ensureReadmeToc(
  content: string,
  relativePath: string,
  projectId: string,
  pages: WikiPageCard[],
): string {
  if (!/(^|\/)README\.md$/i.test(relativePath)) return content;

  const files = pages
    .filter((page) => (page.project_id || projectId) === projectId)
    .filter((page) => !isReadme(page))
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));

  const tocBody =
    files.length > 0
      ? files.map((page) => `- [${page.title}](${page.relative_path})`).join("\n")
      : "_No pages yet._";
  const tocSection = `## Table of contents\n\n${tocBody}\n`;

  if (/\n## (?:Pages|Table of contents)\n/i.test(content)) {
    return content.replace(
      /\n## (?:Pages|Table of contents)\n[\s\S]*?(?=\n## |\s*$)/i,
      `\n${tocSection}`,
    );
  }

  const traffic = content.match(/\n## Traffic snapshot\n[\s\S]*?(?=\n## |\s*$)/i);
  if (traffic && traffic.index != null) {
    const end = traffic.index + traffic[0].length;
    return `${content.slice(0, end)}\n\n${tocSection}${content.slice(end)}`;
  }

  return `${content.trimEnd()}\n\n${tocSection}`;
}

function resolveWikiLink(
  href: string,
  currentRelativePath: string,
  pages: WikiPageCard[],
): WikiPageCard | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return null;

  const pathPart = normalizeWikiPath(trimmed.split("#")[0] ?? "");
  if (!pathPart) return null;

  const currentDir = currentRelativePath.includes("/")
    ? currentRelativePath.slice(0, currentRelativePath.lastIndexOf("/"))
    : "";
  const resolved = pathPart.startsWith("/")
    ? normalizeWikiPath(pathPart)
    : joinWikiPath(currentDir, pathPart);

  const candidates = [
    resolved,
    resolved.endsWith(".md") ? resolved : `${resolved}.md`,
    `${resolved.replace(/\.md$/i, "")}/README.md`,
    `${resolved.replace(/\.md$/i, "")}/index.md`,
  ];

  for (const candidate of candidates) {
    const hit = pages.find(
      (page) => page.relative_path.replace(/\\/g, "/").toLowerCase() === candidate.toLowerCase(),
    );
    if (hit) return hit;
  }
  return null;
}

export function WikiBoard({
  wiki,
  busy,
  wikiEnabled,
  onOpenFolder,
  onEnable,
  loadPage,
}: WikiBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState("");
  const [activePath, setActivePath] = useState("");
  const [activeUpdated, setActiveUpdated] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const pages = wiki?.pages ?? [];

  // Stay aligned with filesystem: drop deleted projects/pages; reload updates.
  useEffect(() => {
    if (!activeId) return;
    const page = pages.find((p) => p.id === activeId);
    if (!page) {
      setActiveId(null);
      setContent(null);
      setPageError(null);
      return;
    }
    if (page.updated_at !== activeUpdated) {
      setActiveTitle(page.title);
      setActivePath(page.relative_path);
      setActiveUpdated(page.updated_at);
      setLoadingPage(true);
      void loadPage(page)
        .then((full) => {
          setContent(ensureReadmeToc(full, page.relative_path, page.project_id, pages));
          setPageError(null);
        })
        .catch((e) => {
          setPageError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setLoadingPage(false));
    }
  }, [pages, activeId, activeUpdated, loadPage]);

  const projects = useMemo(() => {
    const byProject = new Map<string, WikiPageCard[]>();
    for (const page of pages) {
      const key = page.project_id || wiki?.project_id || "default";
      const list = byProject.get(key) ?? [];
      list.push(page);
      byProject.set(key, list);
    }

    const entries: ProjectEntry[] = [];
    for (const [projectId, projectPages] of byProject) {
      const readme =
        projectPages.find(isReadme) ??
        projectPages.find((page) => page.relative_path.toLowerCase() === "readme.md");
      if (!readme) continue;
      entries.push({
        projectId,
        label: projectLabel(projectId, readme),
        readme,
      });
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }, [pages, wiki?.project_id]);

  async function openPage(page: WikiPageCard) {
    setActiveId(page.id);
    setActiveTitle(page.title);
    setActivePath(page.relative_path);
    setActiveUpdated(page.updated_at);
    setContent(ensureReadmeToc(page.preview, page.relative_path, page.project_id, pages));
    setPageError(null);
    setLoadingPage(true);
    try {
      const full = await loadPage(page);
      setContent(ensureReadmeToc(full, page.relative_path, page.project_id, pages));
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingPage(false);
    }
  }

  function closeReader() {
    setActiveId(null);
    setContent(null);
    setPageError(null);
  }

  function markdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
    const target = href ? resolveWikiLink(href, activePath, pages) : null;
    if (target) {
      return (
        <a
          {...rest}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            void openPage(target);
          }}
        >
          {children}
        </a>
      );
    }
    if (href && /^(https?:|mailto:|tel:)/i.test(href)) {
      return (
        <a {...rest} href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    }
    return (
      <a {...rest} href={href}>
        {children}
      </a>
    );
  }

  if (activeId) {
    return (
      <div className={styles.wikiReader}>
        <div className={styles.wikiReaderBar}>
          <button type="button" className={styles.wikiBack} onClick={closeReader}>
            ← Projects
          </button>
          <div className={styles.wikiReaderMeta}>
            <strong>{activeTitle}</strong>
            <span>
              {activePath}
              {activeUpdated ? ` · ${relativeWhen(activeUpdated)}` : ""}
              {loadingPage ? " · loading" : ""}
            </span>
          </div>
          <Button variant="ghost" onClick={onOpenFolder}>
            Reveal
          </Button>
        </div>
        {pageError && <Banner tone="error">{pageError}</Banner>}
        <article className={styles.wikiDoc}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: markdownLink }}>
            {content ?? ""}
          </ReactMarkdown>
        </article>
      </div>
    );
  }

  return (
    <div className={styles.wikiBoard}>
      <p className={styles.wikiBoardLede}>One README per project — open it, then follow links.</p>

      {projects.length === 0 ? (
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
      ) : (
        <section className={styles.wikiSection}>
          <div className={styles.wikiGrid}>
            {projects.map(({ projectId, label, readme }) => {
              const hue = coverTone(`${projectId}/${label}`);
              return (
                <button
                  key={projectId}
                  type="button"
                  className={styles.wikiTile}
                  onClick={() => void openPage(readme)}
                >
                  <div
                    className={styles.wikiTileCover}
                    style={{
                      background: `linear-gradient(160deg, hsl(${hue} 28% 14%) 0%, hsl(${hue} 18% 8%) 100%)`,
                    }}
                  >
                    <div className={styles.wikiTilePreview} aria-hidden>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {readme.preview || "_Empty README_"}
                      </ReactMarkdown>
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
      )}
    </div>
  );
}
