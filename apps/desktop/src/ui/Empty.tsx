import type { JSX } from "solid-js";
import { splitProps } from "solid-js";
import { cn } from "#lib/utils";

export function Empty(props: JSX.HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <p
      class={cn("m-0 py-2 text-center text-[13px] text-muted-foreground", local.class)}
      {...rest}
    />
  );
}
