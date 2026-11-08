import type { WikiPageCard } from "./WikiBoard";
import { isDefined } from "../lib/nullish";

const wikiPathCollator = new Intl.Collator(undefined, { sensitivity: "base" });

export function relativeWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return "—";
  }
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) {
    return "just now";
  }
  if (sec < 3600) {
    return `${Math.round(sec / 60)}m ago`;
  }
  if (sec < 86_400) {
    return `${Math.round(sec / 3600)}h ago`;
  }
  if (sec < 86_400 * 14) {
    return `${Math.round(sec / 86_400)}d ago`;
  }
  return new Date(t).toLocaleDateString();
}

export function coverTone(key: string): number {
  let hash = 0;
  const s = key.toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    const cp = s.codePointAt(i) ?? 0;
    hash = (hash * 31 + cp) >>> 0;
    if (cp > 0xff_ff) {
      i += 1;
    }
  }
  const hues = [24, 210, 158, 280, 190, 45, 330];
  return hues[hash % hues.length] ?? 24;
}

export function isReadme(page: WikiPageCard): boolean {
  return /(?<sep>^|\/)README\.md$/iu.test(page.relative_path);
}

export function projectLabel(projectId: string, readme: WikiPageCard): string {
  const id = projectId.trim();
  if (id !== "" && id.toLowerCase() !== "default") {
    return id;
  }
  const title = readme.title.trim();
  if (title !== "" && title.toLowerCase() !== "readme") {
    return title;
  }
  return "Project";
}

export function normalizeWikiPath(raw: string): string {
  return raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
}

export function joinWikiPath(baseDir: string, href: string): string {
  const parts = [...(baseDir !== "" ? baseDir.split("/") : []), ...normalizeWikiPath(href).split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      /* skip */
    } else if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export function ensureReadmeToc(
  content: string,
  relativePath: string,
  projectId: string,
  pages: WikiPageCard[],
): string {
  if (!/(?<sep>^|\/)README\.md$/iu.test(relativePath)) {
    return content;
  }

  const files = pages
    .filter((page) => (page.project_id || projectId) === projectId)
    .filter((page) => !isReadme(page))
    .slice();
  files.sort((a, b) => wikiPathCollator.compare(a.relative_path, b.relative_path));

  const tocBody =
    files.length > 0
      ? files.map((page) => `- [${page.title}](${page.relative_path})`).join("\n")
      : "_No pages yet._";
  const tocSection = `## Table of contents\n\n${tocBody}\n`;

  if (/\n## (?:Pages|Table of contents)\n/iu.test(content)) {
    return content.replace(
      /\n## (?:Pages|Table of contents)\n[\s\S]*?(?=\n## |\s*$)/iu,
      () => `\n${tocSection}`,
    );
  }

  const traffic = /\n## Traffic snapshot\n[\s\S]*?(?=\n## |\s*$)/iu.exec(content);
  if (isDefined(traffic?.index)) {
    const end = traffic.index + traffic[0].length;
    return `${content.slice(0, end)}\n\n${tocSection}${content.slice(end)}`;
  }

  return `${content.trimEnd()}\n\n${tocSection}`;
}

export function resolveWikiLink(
  href: string,
  currentRelativePath: string,
  pages: WikiPageCard[],
): WikiPageCard | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }
  if (/^(?<scheme>https?|mailto|tel):/iu.test(trimmed)) {
    return null;
  }

  const pathPart = normalizeWikiPath(trimmed.split("#")[0] ?? "");
  if (pathPart === "") {
    return null;
  }

  const currentDir = currentRelativePath.includes("/")
    ? currentRelativePath.slice(0, currentRelativePath.lastIndexOf("/"))
    : "";
  const resolved = pathPart.startsWith("/")
    ? normalizeWikiPath(pathPart)
    : joinWikiPath(currentDir, pathPart);

  const candidates = [
    resolved,
    resolved.endsWith(".md") ? resolved : `${resolved}.md`,
    `${resolved.replace(/\.md$/iu, "")}/README.md`,
    `${resolved.replace(/\.md$/iu, "")}/index.md`,
  ];

  for (const candidate of candidates) {
    const hit = pages.find(
      (page) => page.relative_path.replaceAll("\\", "/").toLowerCase() === candidate.toLowerCase(),
    );
    if (hit) {
      return hit;
    }
  }
  return null;
}

export type ProjectEntry = {
  projectId: string;
  label: string;
  readme: WikiPageCard;
};

export function buildWikiProjects(
  pageList: WikiPageCard[],
  fallbackProjectId: string | undefined,
): ProjectEntry[] {
  const byProject = new Map<string, WikiPageCard[]>();
  for (const page of pageList) {
    const key = page.project_id !== "" ? page.project_id : (fallbackProjectId ?? "default");
    const list = byProject.get(key) ?? [];
    list.push(page);
    byProject.set(key, list);
  }

  const entries: ProjectEntry[] = [];
  for (const [projectId, projectPages] of byProject) {
    const readme =
      projectPages.find((page) => isReadme(page)) ??
      projectPages.find((page) => page.relative_path.toLowerCase() === "readme.md");
    if (!readme) {
      /* skip projects without README */
    } else {
      entries.push({
        projectId,
        label: projectLabel(projectId, readme),
        readme,
      });
    }
  }
  const sorted = entries.slice();
  sorted.sort((a, b) => wikiPathCollator.compare(a.label, b.label));
  return sorted;
}
