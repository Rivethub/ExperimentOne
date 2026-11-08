import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "#lib/utils";

export type ActionsProps = HTMLAttributes<HTMLDivElement> & {
  /** Add the default top margin used under panel content. */
  spaced?: boolean;
  align?: "start" | "end";
};

export function Actions({
  spaced = true,
  align = "start",
  className,
  ...rest
}: ActionsProps): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        spaced && "mt-3.5",
        align === "end" && "justify-end",
        className,
      )}
      {...rest}
    />
  );
}
