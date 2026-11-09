import { createHashHistory, createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen";

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
