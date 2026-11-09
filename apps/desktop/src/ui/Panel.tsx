import type { JSX, ValidComponent } from "solid-js";
import { Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#components/ui/card";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

export type PanelProps = Omit<JSX.HTMLAttributes<HTMLElement>, "title"> & {
  title?: JSX.Element;
  lede?: JSX.Element;
  /** Optional controls aligned opposite the title. */
  actions?: JSX.Element;
  as?: ValidComponent;
};

export function Panel(props: PanelProps): JSX.Element {
  const [local, rest] = splitProps(props, ["title", "lede", "actions", "as", "class", "children"]);
  const hasHead = () => isDefined(local.title) || isDefined(local.actions);

  return (
    <Dynamic
      component={local.as ?? "section"}
      class={cn(
        "mb-3.5 flex flex-col gap-0 rounded-xl border border-border/80 bg-card py-4 text-card-foreground shadow-none",
        local.class,
      )}
      {...rest}
    >
      <Show
        when={hasHead()}
        fallback={
          <Show when={isDefined(local.lede)}>
            <CardDescription class="mb-3.5 max-w-[68ch] px-4.5 text-[13px] leading-snug">
              {local.lede}
            </CardDescription>
          </Show>
        }
      >
        <CardHeader class="mb-2 grid-cols-[1fr_auto] items-start gap-4 px-4.5 pb-0">
          <div>
            <Show when={isDefined(local.title)}>
              <CardTitle class="mb-1 text-sm font-semibold">{local.title}</CardTitle>
            </Show>
            <Show when={isDefined(local.lede)}>
              <CardDescription class="max-w-[68ch] text-[13px] leading-snug">
                {local.lede}
              </CardDescription>
            </Show>
          </div>
          <Show when={isDefined(local.actions)}>
            <CardAction class="self-start">{local.actions}</CardAction>
          </Show>
        </CardHeader>
      </Show>
      <Show when={isDefined(local.children)}>
        <CardContent class="px-4.5">{local.children}</CardContent>
      </Show>
    </Dynamic>
  );
}

export function Lede(props: JSX.HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <p
      class={cn("mb-3.5 max-w-[68ch] text-[13px] leading-snug text-muted-foreground", local.class)}
      {...rest}
    />
  );
}
