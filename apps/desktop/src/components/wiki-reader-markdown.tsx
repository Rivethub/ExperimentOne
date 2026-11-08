import { useMemo, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WikiLinkContext, type WikiLinkContextValue } from "./wiki-link-context";
import { WikiMarkdownAnchor } from "./wiki-markdown-anchor";

const WIKI_REMARK_PLUGINS = [remarkGfm];

const WIKI_MARKDOWN_COMPONENTS = {
  a: WikiMarkdownAnchor,
};

export function WikiReaderMarkdown({
  content,
  activePath,
  pageList,
  onOpenPage,
}: WikiLinkContextValue & { content: string }): ReactElement {
  const ctx = useMemo(
    (): WikiLinkContextValue => ({ activePath, pageList, onOpenPage }),
    [activePath, pageList, onOpenPage],
  );

  return (
    <WikiLinkContext.Provider value={ctx}>
      <ReactMarkdown remarkPlugins={WIKI_REMARK_PLUGINS} components={WIKI_MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </WikiLinkContext.Provider>
  );
}

export function WikiTilePreviewMarkdown({ preview }: { preview: string }): ReactElement {
  return <ReactMarkdown remarkPlugins={WIKI_REMARK_PLUGINS}>{preview}</ReactMarkdown>;
}
