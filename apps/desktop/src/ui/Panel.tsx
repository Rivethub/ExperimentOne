import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import {
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#components/ui/card";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

export type PanelProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  lede?: ReactNode;
  /** Optional controls aligned opposite the title. */
  actions?: ReactNode;
  as?: "section" | "div" | "article";
};

export function Panel({
  title,
  lede,
  actions,
  as: Tag = "section",
  className,
  children,
  ...rest
}: PanelProps): ReactElement {
  const hasHead = isDefined(title) || isDefined(actions);

  return (
    <Tag
      className={cn(
        "mb-3.5 flex flex-col gap-0 rounded-xl border border-border/80 bg-card py-4 text-card-foreground shadow-none",
        className,
      )}
      {...rest}
    >
      {hasHead ? (
        <CardHeader className="mb-2 grid-cols-[1fr_auto] items-start gap-4 px-4.5 pb-0">
          <div>
            {isDefined(title) ? (
              <CardTitle className="mb-1 text-sm font-semibold">{title}</CardTitle>
            ) : null}
            {isDefined(lede) ? (
              <CardDescription className="max-w-[68ch] text-[13px] leading-snug">
                {lede}
              </CardDescription>
            ) : null}
          </div>
          {isDefined(actions) ? <CardAction className="self-start">{actions}</CardAction> : null}
        </CardHeader>
      ) : isDefined(lede) ? (
        <CardDescription className="mb-3.5 max-w-[68ch] px-4.5 text-[13px] leading-snug">
          {lede}
        </CardDescription>
      ) : null}
      {isDefined(children) ? <CardContent className="px-4.5">{children}</CardContent> : null}
    </Tag>
  );
}

export function Lede({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>): ReactElement {
  return (
    <p
      className={cn(
        "mb-3.5 max-w-[68ch] text-[13px] leading-snug text-muted-foreground",
        className,
      )}
      {...rest}
    />
  );
}
