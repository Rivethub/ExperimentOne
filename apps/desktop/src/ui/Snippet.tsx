import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "#lib/utils";

export function Snippet({ className, ...rest }: HTMLAttributes<HTMLPreElement>): ReactElement {
  return (
    <pre
      className={cn(
        "mt-2.5 max-h-60 overflow-auto rounded-lg border border-border/60 bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap text-zinc-300",
        className,
      )}
      {...rest}
    />
  );
}
