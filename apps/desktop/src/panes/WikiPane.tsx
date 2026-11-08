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
};

export function WikiPane({
  active,
  wiki,
  busy,
  wikiEnabled,
  onOpenFolder,
  onEnable,
  loadPage,
}: WikiPaneProps) {
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
      />
    </div>
  );
}
