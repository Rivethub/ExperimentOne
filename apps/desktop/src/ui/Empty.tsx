import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "#lib/utils";

export function Empty({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>): ReactElement {
  return (
    <p
      className={cn("m-0 py-2 text-center text-[13px] text-muted-foreground", className)}
      {...rest}
    />
  );
}
