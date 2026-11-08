import type { HTMLAttributes, ReactNode } from "react";
import { useId } from "react";
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
}: ModalProps) {
  const autoId = useId();
  const labelledBy = title ? (titleId ?? autoId) : undefined;
  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={() => {
        if (closeOnBackdrop) onClose();
      }}
    >
      <div
        className={cx(styles.card, wide && styles.wide, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {(title != null || headerExtra != null) && (
          <div className={styles.header}>
            {title != null ? <h2 id={labelledBy}>{title}</h2> : <span />}
            {headerExtra}
          </div>
        )}
        {children != null ? <div className={styles.body}>{children}</div> : null}
        {footer != null ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ModalActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
