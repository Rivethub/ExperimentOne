import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "#lib/utils";

export type FieldRowProps = HTMLAttributes<HTMLDivElement> & {
  /** Remove the default top margin. */
  flush?: boolean;
};

export function FieldRow({ flush, className, ...rest }: FieldRowProps): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        flush === true ? "mt-0" : "mt-3",
        className,
      )}
      {...rest}
    />
  );
}
