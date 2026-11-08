import { Button, Input } from "../ui";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export type ExportPaneProps = {
  active: boolean;
  busy: boolean;
  bagPath: string | null;
  importPath: string;
  bagNote: string | null;
  onImportPathChange: (path: string) => void;
  onExport: () => void;
  onRevealExport: () => void;
  onPickImport: () => void;
  onImport: () => void;
};

export function ExportPane({
  active,
  busy,
  bagPath,
  importPath,
  bagNote,
  onImportPathChange,
  onExport,
  onRevealExport,
  onPickImport,
  onImport,
}: ExportPaneProps) {
  return (
    <div
      className={cx(styles.viewPane, active ? styles.isActive : "")}
      hidden={!active}
      aria-hidden={!active}
    >
      <div className={styles.xfer}>
        <div className={styles.xferGrid}>
          <section className={cx(styles.xferCard, styles.export)}>
            <div className={styles.xferCardTop}>
              <span className={styles.xferGlyph} aria-hidden>
                ⇪
              </span>
              <div>
                <h3>Export</h3>
                <p>Write a traffic package from the local store.</p>
              </div>
            </div>
            <ul className={styles.xferBullets}>
              <li>OAuth dirs and proxy secrets excluded</li>
              <li>Bodies redacted best-effort before pack</li>
              <li>Saved under the local Rivet data directory / exports</li>
            </ul>
            <div className={styles.xferActions}>
              <Button variant="primary" disabled={busy} onClick={onExport}>
                Export .rivetbag
              </Button>
              <Button disabled={busy || !bagPath} onClick={onRevealExport}>
                Reveal last
              </Button>
            </div>
            {bagPath && (
              <div className={styles.xferPath} title={bagPath}>
                <span>Last export</span>
                <code>{bagPath}</code>
              </div>
            )}
          </section>

          <section className={cx(styles.xferCard, styles.import)}>
            <div className={styles.xferCardTop}>
              <span className={styles.xferGlyph} aria-hidden>
                ⇩
              </span>
              <div>
                <h3>Import</h3>
                <p>Merge a package into this Rivet store.</p>
              </div>
            </div>
            <div className={styles.xferDrop}>
              <Input
                placeholder="/absolute/path/to/file.rivetbag"
                value={importPath}
                onChange={(e) => onImportPathChange(e.target.value)}
              />
              <div className={styles.xferActions}>
                <Button disabled={busy} onClick={onPickImport}>
                  Choose file
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !importPath.trim()}
                  onClick={onImport}
                >
                  Import
                </Button>
              </div>
            </div>
          </section>
        </div>

        {bagNote && (
          <div className={styles.xferToast} role="status">
            <span className={styles.xferToastDot} />
            {bagNote}
          </div>
        )}

        <aside className={styles.xferNote}>
          Captured prompt/completion text can still hold secrets. Redaction is pattern matching —
          treat bags as sensitive.
        </aside>
      </div>
    </div>
  );
}
