import { useContext, type JSX, splitProps } from "solid-js";
import { Show } from "solid-js";
import { WikiLinkContext } from "./wiki-link-context";
import { WikiMarkdownLink } from "./wiki-markdown-link";

export function WikiMarkdownAnchor(
  props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>,
): JSX.Element {
  const ctx = useContext(WikiLinkContext);
  return (
    <Show
      when={ctx}
      fallback={(() => {
        const [local, rest] = splitProps(props, ["children"]);
        return <a {...rest}>{local.children}</a>;
      })()}
    >
      {(value) => (
        <WikiMarkdownLink
          {...props}
          activePath={value().activePath}
          pageList={value().pageList}
          onOpenPage={value().onOpenPage}
        />
      )}
    </Show>
  );
}
