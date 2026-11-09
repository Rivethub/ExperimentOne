import { createRootRoute } from "@tanstack/solid-router";
import { AppShell } from "#app/shell";

export const Route = createRootRoute({
  component: AppShell,
});
