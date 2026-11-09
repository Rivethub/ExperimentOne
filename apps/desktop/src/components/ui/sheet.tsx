import type { ComponentProps, ValidComponent } from "solid-js";
import { Show, mergeProps, splitProps } from "solid-js";
import { Dialog as SheetPrimitive } from "@kobalte/core/dialog";
import { cx } from "#lib/cva";

export type SheetProps = ComponentProps<typeof SheetPrimitive>;

export const Sheet = (props: SheetProps) => {
  return <SheetPrimitive data-slot="sheet" {...props} />;
};

export type SheetTriggerProps<T extends ValidComponent = "button"> = ComponentProps<
  typeof SheetPrimitive.Trigger<T>
>;

export const SheetTrigger = <T extends ValidComponent = "button">(props: SheetTriggerProps<T>) => {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
};

export type SheetCloseButtonProps<T extends ValidComponent = "button"> = ComponentProps<
  typeof SheetPrimitive.CloseButton<T>
>;

export const SheetCloseButton = <T extends ValidComponent = "button">(
  props: SheetCloseButtonProps<T>,
) => {
  return <SheetPrimitive.CloseButton data-slot="sheet-close" {...props} />;
};

export const SheetClose = SheetCloseButton;

export type SheetContentProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SheetPrimitive.Content<T>
> & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
};

export const SheetContent = <T extends ValidComponent = "div">(props: SheetContentProps<T>) => {
  const merge = mergeProps(
    {
      side: "right" as const,
      showCloseButton: true,
    } as SheetContentProps,
    props,
  );
  const [, rest] = splitProps(merge, ["class", "children", "side", "showCloseButton"]);
  const side = () => merge.side ?? "right";

  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        class="fixed inset-0 z-50 bg-black/50 data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:animate-in data-[expanded]:fade-in-0"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        class={cx(
          "fixed z-50 flex flex-col gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[closed]:animate-out data-[closed]:duration-300 data-[expanded]:animate-in data-[expanded]:duration-500",
          side() === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l data-[closed]:slide-out-to-right data-[expanded]:slide-in-from-right sm:max-w-sm",
          side() === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r data-[closed]:slide-out-to-left data-[expanded]:slide-in-from-left sm:max-w-sm",
          side() === "top" &&
            "inset-x-0 top-0 h-auto border-b data-[closed]:slide-out-to-top data-[expanded]:slide-in-from-top",
          side() === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t data-[closed]:slide-out-to-bottom data-[expanded]:slide-in-from-bottom",
          props.class,
        )}
        {...rest}
      >
        {props.children}
        <Show when={merge.showCloseButton}>
          <SheetPrimitive.CloseButton
            aria-label="Close"
            class="absolute top-4 right-4 rounded-xs opacity-70 transition-[opacity,box-shadow] duration-200 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
              <path
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M18 6L6 18M6 6l12 12"
              />
            </svg>
          </SheetPrimitive.CloseButton>
        </Show>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
};

export type SheetHeaderProps = ComponentProps<"div">;

export const SheetHeader = (props: SheetHeaderProps) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <div data-slot="sheet-header" class={cx("flex flex-col gap-1.5", props.class)} {...rest} />
  );
};

export type SheetFooterProps = ComponentProps<"div">;

export const SheetFooter = (props: SheetFooterProps) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <div
      data-slot="sheet-footer"
      class={cx("mt-auto flex flex-col gap-2", props.class)}
      {...rest}
    />
  );
};

export type SheetTitleProps<T extends ValidComponent = "h2"> = ComponentProps<
  typeof SheetPrimitive.Title<T>
>;

export const SheetTitle = <T extends ValidComponent = "h2">(props: SheetTitleProps<T>) => {
  const [, rest] = splitProps(props as SheetTitleProps, ["class"]);
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      class={cx("font-semibold text-foreground", props.class)}
      {...rest}
    />
  );
};

export type SheetDescriptionProps<T extends ValidComponent = "p"> = ComponentProps<
  typeof SheetPrimitive.Description<T>
>;

export const SheetDescription = <T extends ValidComponent = "p">(
  props: SheetDescriptionProps<T>,
) => {
  const [, rest] = splitProps(props as SheetDescriptionProps, ["class"]);
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      class={cx("text-sm text-muted-foreground", props.class)}
      {...rest}
    />
  );
};
