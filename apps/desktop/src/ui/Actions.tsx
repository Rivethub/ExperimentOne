import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "#lib/utils";

export type ActionsProps = JSX.HTMLAttributes<HTMLDivElement> & {
  /** Add the default top margin used under panel content. */
  spaced?: boolean;
  align?: "start" | "end";
};

export function Actions(props: ActionsProps): JSX.Element {
  const [local, rest] = splitProps(props, ["spaced", "align", "class"]);
  return (
    <div
      class={cn(
        "flex flex-wrap items-center gap-2",
        local.spaced !== false && "mt-3.5",
        local.align === "end" && "justify-end",
        local.class,
      )}
      {...rest}
    />
  );
}
