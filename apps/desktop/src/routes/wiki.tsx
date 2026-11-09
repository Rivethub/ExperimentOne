import type { JSX } from "solid-js";
import { createFileRoute } from "@tanstack/solid-router";
import { useApp } from "#app/context";
import { useWiki } from "#hooks";
import { WikiPane } from "#panes";

export const Route = createFileRoute("/wiki")({
  component: WikiPage,
});

function WikiPage(): JSX.Element {
  const app = useApp();
  const wiki = useWiki();

  return (
    <WikiPane
      wiki={wiki.wiki}
      busy={app.busy()}
      wikiEnabled={!!app.rivet.status?.capabilities.wiki}
      onOpenFolder={() => void app.ops.openWiki()}
      onEnable={() => app.openSettings("intelligence")}
      loadPage={wiki.loadWikiPage}
      listArchives={wiki.listArchives}
      loadArchive={wiki.loadArchive}
    />
  );
}
