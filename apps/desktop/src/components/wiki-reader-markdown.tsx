import type { JSX } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { WikiLinkContext, type WikiLinkContextValue } from "./wiki-link-context";
import { WikiMarkdownAnchor } from "./wiki-markdown-anchor";

const WIKI_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const WIKI_REHYPE_PLUGINS = [rehypeSanitize];

const WIKI_MARKDOWN_COMPONENTS = {
  a: WikiMarkdownAnchor,
};

export function WikiReaderMarkdown(props: WikiLinkContextValue & { content: string }): JSX.Element {
  const ctx: WikiLinkContextValue = {
    get activePath() {
      return props.activePath;
    },
    get pageList() {
      return props.pageList;
    },
    onOpenPage: props.onOpenPage,
  };

  return (
    <WikiLinkContext.Provider value={ctx}>
      <SolidMarkdown
        remarkPlugins={WIKI_REMARK_PLUGINS}
        rehypePlugins={WIKI_REHYPE_PLUGINS}
        components={WIKI_MARKDOWN_COMPONENTS}
      >
        {props.content}
      </SolidMarkdown>
    </WikiLinkContext.Provider>
  );
}

export function WikiTilePreviewMarkdown(props: { preview: string }): JSX.Element {
  return (
    <SolidMarkdown remarkPlugins={WIKI_REMARK_PLUGINS} rehypePlugins={WIKI_REHYPE_PLUGINS}>
      {props.preview}
    </SolidMarkdown>
  );
}
