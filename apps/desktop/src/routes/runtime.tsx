import { createFileRoute } from "@tanstack/react-router";
import { useApp } from "#app/context";
import { RuntimePane } from "#panes";

export const Route = createFileRoute("/runtime")({
  component: RuntimePage,
});

function RuntimePage(): React.ReactElement {
  const { rivet, ops, openSettings } = useApp();

  return (
    <RuntimePane
      status={rivet.status}
      accounts={rivet.accounts}
      apiOnline={rivet.apiOnline}
      lastSyncedAt={rivet.lastSyncedAt}
      proxyLog={ops.proxyLog}
      chLog={ops.chLog}
      onCopyText={(t) => void ops.copyText(t)}
      onOpenSettings={openSettings}
      onRefresh={() => void rivet.refresh()}
      onLoadLogs={() => void ops.loadLogs()}
    />
  );
}
