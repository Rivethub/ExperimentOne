import { createFileRoute } from "@tanstack/react-router";
import { useApp } from "#app/context";
import { useWiki } from "#hooks";
import { WikiPane } from "#panes";

export const Route = createFileRoute("/wiki")({
  component: WikiPage,
});

function WikiPage(): React.ReactElement {
  const { rivet, ops, busy, openSettings } = useApp();
  const wiki = useWiki();

  return (
    <WikiPane
      wiki={wiki.wiki}
      busy={busy}
      wikiEnabled={!!rivet.status?.capabilities.wiki}
      onOpenFolder={() => void ops.openWiki()}
      onEnable={() => openSettings("intelligence")}
      loadPage={wiki.loadWikiPage}
      listArchives={wiki.listArchives}
      loadArchive={wiki.loadArchive}
    />
  );
}
