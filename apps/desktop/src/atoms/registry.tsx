import { RegistryContext } from "@effect/atom-solid";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { JSX, ParentProps } from "solid-js";

/** Shared registry so mutations can refresh atoms outside Solid subscriptions. */
export const appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider(props: ParentProps): JSX.Element {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>{props.children}</RegistryContext.Provider>
  );
}
