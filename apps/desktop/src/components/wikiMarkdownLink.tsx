import type { ComponentPropsWithoutRef, ReactElement } from "react";
import { resolveWikiLink } from "./wikiBoardLogic";
import type { WikiPageCard } from "./WikiBoard";

export function WikiMarkdownLink({
  href,
  children,
  activePath,
  pageList,
  onOpenPage,
  ...rest
}: ComponentPropsWithoutRef<"a"> & {
  activePath: string;
  pageList: WikiPageCard[];
  onOpenPage: (page: WikiPageCard) => void;
}): ReactElement {
  const trimmedHref = href ?? "";
  const target = trimmedHref !== "" ? resolveWikiLink(trimmedHref, activePath, pageList) : null;
  if (target) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onOpenPage(target);
        }}
      >
        {children}
      </a>
    );
  }
  if (trimmedHref !== "" && /^(?<scheme>https?|mailto|tel):/iu.test(trimmedHref)) {
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
