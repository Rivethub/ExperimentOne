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

export function WikiPane({
  wiki,
  busy,
  wikiEnabled,
  initialPageId,
  onOpenFolder,
  onEnable,
  onOpenTopic,
  onBrowseTopics,
  onClearInitialPage,
  loadPage,
  listArchives,
  loadArchive,
}: WikiPaneProps): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <WikiBoard
        wiki={wiki}
        busy={busy}
        wikiEnabled={wikiEnabled}
        initialPageId={initialPageId}
        onOpenFolder={onOpenFolder}
        onEnable={onEnable}
        onOpenTopic={onOpenTopic}
        onBrowseTopics={onBrowseTopics}
        onClearInitialPage={onClearInitialPage}
        loadPage={loadPage}
        listArchives={listArchives}
        loadArchive={loadArchive}
      />
    </div>
  );
}
