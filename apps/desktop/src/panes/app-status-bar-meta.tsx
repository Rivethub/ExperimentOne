import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Button } from "#components/ui/button";
import { cn } from "#lib/utils";
import { isDefined } from "../lib/nullish";

export function AppStatusBarProxyPill(props: {
  proxyRunning: boolean | undefined;
  proxyBaseUrl: string | undefined;
  onOpenRuntime: () => void;
}): JSX.Element {
  const live = () => props.proxyRunning === true;
  const url = () =>
    isDefined(props.proxyBaseUrl) && props.proxyBaseUrl !== "" ? props.proxyBaseUrl : null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="h-6 max-w-none shrink-0 gap-1.5 px-1.5 text-[11.5px] text-muted-foreground"
      title={url() ?? "Proxy"}
      onClick={() => props.onOpenRuntime()}
    >
      <span
        class={cn(
          "size-[7px] shrink-0 rounded-full",
          live() ? "bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]" : "bg-red-400",
        )}
      />
      <span class="@max-[860px]:hidden">proxy {live() ? "live" : "stopped"}</span>
      <span class="hidden @max-[860px]:inline">{live() ? "proxy" : "proxy↓"}</span>
      <Show when={url()}>
        {(u) => (
          <span class="max-w-44 overflow-hidden text-ellipsis text-muted-foreground/80 @max-[980px]:hidden">
            {u().replace("http://", "")}
          </span>
        )}
      </Show>
    </Button>
  );
}
