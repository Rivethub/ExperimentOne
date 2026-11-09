import { Atom } from "effect/reactivity";
import { AppLive } from "../effect/layers";

/** Shared Atom runtime that provides AppLive (IPC, HttpClient, KeyValueStore). */
export const appRuntime = Atom.runtime(AppLive);
