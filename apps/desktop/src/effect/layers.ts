import * as BrowserHttpClient from "@effect/platform-browser/BrowserHttpClient";
import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import { Layer } from "effect";
import { RivetIpcLive } from "./ipc";

/**
 * App-edge services for the desktop webview:
 * - RivetIpc — Tauri invoke → rivetd
 * - HttpClient — browser fetch (platform-browser)
 * - KeyValueStore — localStorage (platform-browser)
 */
export const AppLive = Layer.mergeAll(
  RivetIpcLive,
  BrowserHttpClient.layerFetch,
  BrowserKeyValueStore.layerLocalStorage,
);
