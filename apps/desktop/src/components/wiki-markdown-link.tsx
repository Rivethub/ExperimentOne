import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { resolveWikiLink } from "./wiki-board-logic";
import type { WikiPageCard } from "./WikiBoard";

export function WikiMarkdownLink(
  props: JSX.AnchorHTMLAttributes<HTMLAnchorElement> & {
    activePath: string;
    pageList: WikiPageCard[];
    onOpenPage: (page: WikiPageCard) => void;
  },
): JSX.Element {
  const [local, rest] = splitProps(props, [
    "href",
    "children",
    "activePath",
    "pageList",
    "onOpenPage",
  ]);
  const trimmedHref = () => local.href ?? "";
  const target = () =>
    trimmedHref() !== "" ? resolveWikiLink(trimmedHref(), local.activePath, local.pageList) : null;
  if (target()) {
    return (
      <a
        {...rest}
        href={local.href}
        onClick={(event) => {
          event.preventDefault();
          const page = target();
          if (page) {
            local.onOpenPage(page);
          }
        }}
      >
        {local.children}
      </a>
    );
  }
  if (trimmedHref() !== "" && /^(?<scheme>https?|mailto|tel):/iu.test(trimmedHref())) {
    return (
      <a {...rest} href={local.href} target="_blank" rel="noreferrer">
        {local.children}
      </a>
    );
  }
  return (
    <a {...rest} href={local.href}>
      {local.children}
    </a>
  );
}
