import { QueryClientProvider } from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { render } from "solid-js/web";
import { AppAtomRegistryProvider } from "./atoms/registry";
import { Toaster } from "./components/ui/sonner";
import { createAppQueryClient } from "./lib/query-client";
import { router } from "./router";
import "./styles/globals.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Missing #root element");
}

const queryClient = createAppQueryClient();

function Root() {
  return (
    <AppAtomRegistryProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </AppAtomRegistryProvider>
  );
}

render(() => <Root />, root);
