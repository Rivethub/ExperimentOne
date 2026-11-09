import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "#lib/utils";

export type FieldRowProps = JSX.HTMLAttributes<HTMLDivElement> & {
  /** Remove the default top margin. */
  flush?: boolean;
};

export function FieldRow(props: FieldRowProps): JSX.Element {
  const [local, rest] = splitProps(props, ["flush", "class"]);
  return (
    <div
      class={cn(
        "flex flex-wrap items-center gap-2",
        local.flush === true ? "mt-0" : "mt-3",
        local.class,
      )}
      {...rest}
    />
  );
}
