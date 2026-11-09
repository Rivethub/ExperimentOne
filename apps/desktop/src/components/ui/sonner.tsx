import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from "lucide-solid";
import { Toaster as Sonner, type ToasterProps } from "solid-sonner";

const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="dark"
    class="toaster group"
    icons={{
      success: <CircleCheck class="size-4" />,
      info: <Info class="size-4" />,
      warning: <TriangleAlert class="size-4" />,
      error: <OctagonX class="size-4" />,
      loading: <Loader2 class="size-4 animate-spin" />,
    }}
    style={{
      "--normal-bg": "var(--popover)",
      "--normal-text": "var(--popover-foreground)",
      "--normal-border": "var(--border)",
      "--border-radius": "var(--radius)",
    }}
    {...props}
  />
);

export { Toaster };
