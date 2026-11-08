import { RegistryContext } from "@effect/atom-react";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createElement, type ReactNode } from "react";

/** Shared registry so mutations can refresh atoms outside React subscriptions. */
export const appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: { children: ReactNode }) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}
