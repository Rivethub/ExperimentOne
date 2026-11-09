import type { JSX } from "solid-js";
import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { useApp } from "#app/context";
import { validateWikiSearch } from "#app/search";
import { useWiki } from "#hooks";
import { WikiPane } from "#panes";

export const Route = createFileRoute("/wiki")({
  validateSearch: validateWikiSearch,
  component: WikiPage,
});

function WikiPage(): JSX.Element {
  const app = useApp();
  const wiki = useWiki();
  const navigate = useNavigate();
  const search = Route.useSearch();

  const initialPageId = () => {
    const page = search().page.trim();
    return page !== "" ? page : null;
  };

  return (
    <WikiPane
      wiki={wiki.wiki}
      busy={app.busy()}
      wikiEnabled={!!app.rivet.status?.capabilities.wiki}
      initialPageId={initialPageId()}
      onOpenFolder={() => void app.ops.openWiki()}
      onEnable={() => app.openSettings("intelligence")}
      onOpenTopic={(slug) => {
        void navigate({
          to: "/topics",
          search: { slug },
        });
      }}
      onBrowseTopics={() => {
        void navigate({
          to: "/topics",
          search: { slug: "" },
        });
      }}
      onClearInitialPage={() => {
        if (search().page.trim() === "") return;
        void navigate({
          to: "/wiki",
          search: { page: "" },
          replace: true,
        });
      }}
      loadPage={wiki.loadWikiPage}
      listArchives={wiki.listArchives}
      loadArchive={wiki.loadArchive}
    />
  );
}
