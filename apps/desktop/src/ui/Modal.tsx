import type { JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
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
  title?: JSX.Element;
  titleId?: string;
  wide?: boolean;
  /** When false, backdrop clicks / escape do nothing (e.g. while a login is active). */
  closeOnBackdrop?: boolean;
  children?: JSX.Element;
  footer?: JSX.Element;
  /** Extra nodes rendered in the title row (pills, status, etc.). */
  headerExtra?: JSX.Element;
  class?: string;
};

export function Modal(props: ModalProps): JSX.Element {
  const closeOnBackdrop = () => props.closeOnBackdrop !== false;
  const preventDismiss = () => !closeOnBackdrop();

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) {
          props.onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        class={cn(
          "max-h-[min(80vh,720px)] gap-0 overflow-auto p-5 sm:max-w-[440px]",
          props.wide === true && "sm:max-w-[560px]",
          props.class,
        )}
        onInteractOutside={(event) => {
          if (preventDismiss()) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (preventDismiss()) {
            event.preventDefault();
          }
        }}
      >
        <Show when={isDefined(props.title) || isDefined(props.headerExtra)}>
          <DialogHeader class="mb-2.5 flex-row items-center justify-between gap-3 space-y-0 text-left">
            <Show when={isDefined(props.title)} fallback={<span />}>
              <DialogTitle id={props.titleId} class="text-[17px] font-semibold">
                {props.title}
              </DialogTitle>
            </Show>
            {props.headerExtra}
          </DialogHeader>
        </Show>
        <Show when={isDefined(props.children)}>
          <div class="min-w-0">{props.children}</div>
        </Show>
        <Show when={isDefined(props.footer)}>
          <DialogFooter class="mt-4.5 flex-row flex-wrap justify-end gap-2 sm:justify-end">
            {props.footer}
          </DialogFooter>
        </Show>
      </DialogContent>
    </Dialog>
  );
}

export function ModalActions(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <div class={cn("mt-4.5 flex flex-wrap justify-end gap-2", local.class)} {...rest} />;
}
