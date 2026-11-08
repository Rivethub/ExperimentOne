import { WikiBoard, type WikiInfo, type WikiPageCard } from "../components/WikiBoard";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type WikiPaneProps = {
  active: boolean;
  wiki: WikiInfo | null;
  busy: boolean;
  wikiEnabled: boolean;
  onOpenFolder: () => void;
  onEnable: () => void;
  loadPage: (page: WikiPageCard) => Promise<string>;
  listArchives?: (projectId: string, slug: string) => Promise<string[]>;
  loadArchive?: (projectId: string, slug: string, file: string) => Promise<string>;
};

export function WikiPane({
  active,
  wiki,
  busy,
  wikiEnabled,
  onOpenFolder,
  onEnable,
  loadPage,
  listArchives,
  loadArchive,
}: WikiPaneProps): React.ReactElement {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <WikiBoard
        wiki={wiki}
        busy={busy}
        wikiEnabled={wikiEnabled}
        onOpenFolder={onOpenFolder}
        onEnable={onEnable}
        loadPage={loadPage}
        listArchives={listArchives}
        loadArchive={loadArchive}
      />
    </div>
  );
}
