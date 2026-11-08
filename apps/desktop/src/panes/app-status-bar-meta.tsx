import { cn } from "#lib/utils";
import { isDefined } from "../lib/nullish";

export function AppStatusBarProxyPill({
  proxyRunning,
  proxyBaseUrl,
  onOpenRuntime,
}: {
  proxyRunning: boolean | undefined;
  proxyBaseUrl: string | undefined;
  onOpenRuntime: () => void;
}): React.ReactElement {
  const live = proxyRunning === true;
  const url = isDefined(proxyBaseUrl) && proxyBaseUrl !== "" ? proxyBaseUrl : null;

  return (
    <button
      type="button"
      className="inline-flex max-w-none shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border-0 bg-transparent px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      title={url ?? "Proxy"}
      onClick={onOpenRuntime}
    >
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          live ? "bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]" : "bg-red-400",
        )}
      />
      <span className="@max-[860px]:hidden">proxy {live ? "live" : "stopped"}</span>
      <span className="hidden @max-[860px]:inline">{live ? "proxy" : "proxy↓"}</span>
      {url !== null ? (
        <span className="max-w-44 overflow-hidden text-ellipsis text-muted-foreground/80 @max-[980px]:hidden">
          {url.replace("http://", "")}
        </span>
      ) : null}
    </button>
  );
}
