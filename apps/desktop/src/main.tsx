import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { AppAtomRegistryProvider } from "./atoms/registry";
import { Toaster } from "./components/ui/sonner";
import { createAppQueryClient } from "./lib/query-client";
import { router } from "./router";
import "./styles/globals.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Missing #root element");
}

function Root() {
  const [queryClient] = useState(createAppQueryClient);
  return (
    <AppAtomRegistryProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </AppAtomRegistryProvider>
  );
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
