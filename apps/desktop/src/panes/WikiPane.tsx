import type { JSX } from "solid-js";
import { WikiBoard, type WikiInfo, type WikiPageCard } from "../components/WikiBoard";

export type WikiPaneProps = {
  wiki: WikiInfo | null;
  busy: boolean;
  wikiEnabled: boolean;
  initialPageId?: string | null;
  onOpenFolder: () => void;
  onEnable: () => void;
  onOpenTopic?: (slug: string) => void;
  onBrowseTopics?: () => void;
  onClearInitialPage?: () => void;
  loadPage: (page: WikiPageCard) => Promise<string>;
  listArchives?: (projectId: string, slug: string) => Promise<string[]>;
  loadArchive?: (projectId: string, slug: string, file: string) => Promise<string>;
};

export function WikiPane(props: WikiPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <WikiBoard
        wiki={props.wiki}
        busy={props.busy}
        wikiEnabled={props.wikiEnabled}
        initialPageId={props.initialPageId}
        onOpenFolder={() => props.onOpenFolder()}
        onEnable={() => props.onEnable()}
        onOpenTopic={props.onOpenTopic}
        onBrowseTopics={props.onBrowseTopics}
        onClearInitialPage={props.onClearInitialPage}
        loadPage={(page) => props.loadPage(page)}
        listArchives={props.listArchives}
        loadArchive={props.loadArchive}
      />
    </div>
  );
}
