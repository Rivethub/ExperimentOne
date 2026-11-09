import type { ComponentProps, JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
import { Dialog as SheetPrimitive } from "@kobalte/core/dialog";
import { X } from "lucide-solid";
import { cn } from "#lib/utils";

function Sheet(props: ComponentProps<typeof SheetPrimitive>) {
  return <SheetPrimitive data-slot="sheet" {...props} />;
}

function SheetTrigger(props: ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: ComponentProps<typeof SheetPrimitive.CloseButton>) {
  return <SheetPrimitive.CloseButton data-slot="sheet-close" {...props} />;
}

function SheetPortal(props: ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay(props: ComponentProps<typeof SheetPrimitive.Overlay>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      class={cn(
        "fixed inset-0 z-50 bg-black/50 data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:animate-in data-[expanded]:fade-in-0",
        local.class,
      )}
      {...rest}
    />
  );
}

function SheetContent(
  props: ComponentProps<typeof SheetPrimitive.Content> & {
    side?: "top" | "right" | "bottom" | "left";
    showCloseButton?: boolean;
  },
) {
  const [local, rest] = splitProps(props, ["class", "children", "side", "showCloseButton"]);
  const side = () => local.side ?? "right";
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        class={cn(
          "fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition ease-in-out data-[closed]:animate-out data-[closed]:duration-300 data-[expanded]:animate-in data-[expanded]:duration-500",
          side() === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l data-[closed]:slide-out-to-right data-[expanded]:slide-in-from-right sm:max-w-sm",
          side() === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r data-[closed]:slide-out-to-left data-[expanded]:slide-in-from-left sm:max-w-sm",
          side() === "top" &&
            "inset-x-0 top-0 h-auto border-b data-[closed]:slide-out-to-top data-[expanded]:slide-in-from-top",
          side() === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t data-[closed]:slide-out-to-bottom data-[expanded]:slide-in-from-bottom",
          local.class,
        )}
        {...rest}
      >
        {local.children}
        <Show when={local.showCloseButton !== false}>
          <SheetPrimitive.CloseButton class="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[expanded]:bg-secondary">
            <X class="size-4" />
            <span class="sr-only">Close</span>
          </SheetPrimitive.CloseButton>
        </Show>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div data-slot="sheet-header" class={cn("flex flex-col gap-1.5 p-4", local.class)} {...rest} />
  );
}

function SheetFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      data-slot="sheet-footer"
      class={cn("mt-auto flex flex-col gap-2 p-4", local.class)}
      {...rest}
    />
  );
}

function SheetTitle(props: ComponentProps<typeof SheetPrimitive.Title>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      class={cn("font-semibold text-foreground", local.class)}
      {...rest}
    />
  );
}

function SheetDescription(props: ComponentProps<typeof SheetPrimitive.Description>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      class={cn("text-sm text-muted-foreground", local.class)}
      {...rest}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
