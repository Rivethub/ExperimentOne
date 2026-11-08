import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog";
import { isDefined } from "#lib/nullish";
import { cn } from "#lib/utils";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  titleId?: string;
  wide?: boolean;
  /** When false, backdrop clicks / escape do nothing (e.g. while a login is active). */
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
  wide = false,
  closeOnBackdrop = true,
  children,
  footer,
  headerExtra,
  className,
}: ModalProps): ReactElement {
  const preventDismiss = !closeOnBackdrop;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-h-[min(80vh,720px)] gap-0 overflow-auto p-5 sm:max-w-[440px]",
          wide && "sm:max-w-[560px]",
          className,
        )}
        onInteractOutside={(event) => {
          if (preventDismiss) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (preventDismiss) {
            event.preventDefault();
          }
        }}
      >
        {(isDefined(title) || isDefined(headerExtra)) && (
          <DialogHeader className="mb-2.5 flex-row items-center justify-between gap-3 space-y-0 text-left">
            {isDefined(title) ? (
              <DialogTitle id={titleId} className="text-[17px] font-semibold">
                {title}
              </DialogTitle>
            ) : (
              <span />
            )}
            {headerExtra}
          </DialogHeader>
        )}
        {isDefined(children) ? <div className="min-w-0">{children}</div> : null}
        {isDefined(footer) ? (
          <DialogFooter className="mt-4.5 flex-row flex-wrap justify-end gap-2 sm:justify-end">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ModalActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn("mt-4.5 flex flex-wrap justify-end gap-2", className)} {...rest} />;
}
