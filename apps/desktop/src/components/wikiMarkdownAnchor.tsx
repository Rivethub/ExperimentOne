import { useContext, type ComponentPropsWithoutRef, type ReactElement } from "react";
import { WikiLinkContext } from "./wikiLinkContext";
import { WikiMarkdownLink } from "./wikiMarkdownLink";

export function WikiMarkdownAnchor(props: ComponentPropsWithoutRef<"a">): ReactElement {
  const ctx = useContext(WikiLinkContext);
  if (ctx === null) {
    const { children, ...rest } = props;
    return (
      <a {...rest}>
        {children}
      </a>
    );
  }
  return (
    <WikiMarkdownLink
      {...props}
      activePath={ctx.activePath}
      pageList={ctx.pageList}
      onOpenPage={ctx.onOpenPage}
    />
  );
}
