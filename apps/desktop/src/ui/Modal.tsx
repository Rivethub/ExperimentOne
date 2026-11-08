import { useId, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { isDefined } from "../nullish";
import { cx } from "../styles/cx";
import styles from "./Modal.module.css";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  titleId?: string;
  wide?: boolean;
  /** When false, backdrop clicks do nothing (e.g. while a login is active). */
  closeOnBackdrop?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  /** Extra nodes rendered in the title row (pills, status, etc.). */
  headerExtra?: ReactNode;
  className?: string;
};

export function Modal({
  open,
  onClose,
  title,
  titleId,
  wide,
  closeOnBackdrop = true,
  children,
  footer,
  headerExtra,
  className,
}: ModalProps): ReactElement | null {
  const autoId = useId();
  const labelledBy = isDefined(title) ? (titleId ?? autoId) : undefined;
  if (!open) {
    return null;
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && closeOnBackdrop) {
          onClose();
        }
      }}
    >
      <div
        className={cx(styles.card, wide === true && styles.wide, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {(isDefined(title) || isDefined(headerExtra)) && (
          <div className={styles.header}>
            {isDefined(title) ? <h2 id={labelledBy}>{title}</h2> : <span />}
            {headerExtra}
          </div>
        )}
        {isDefined(children) ? <div className={styles.body}>{children}</div> : null}
        {isDefined(footer) ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ModalActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
