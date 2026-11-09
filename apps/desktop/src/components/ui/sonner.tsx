import type { ComponentProps } from "solid-js";
import { Toaster as Sonner } from "solid-sonner";

export const Toaster = (props: ComponentProps<typeof Sonner>) => {
  return (
    <Sonner
      theme="dark"
      class="toaster group"
      style={{
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius)",
      }}
      {...props}
    />
  );
};
