import { isString } from "./guards";
import type { JsonObject } from "./jsonTypes";

export async function invokeTauri<T>(cmd: string, args?: JsonObject): Promise<T | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

export async function pickRivetbag(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Rivet traffic", extensions: ["rivetbag"] }],
    });
    if (isString(selected)) {
      return selected;
    }
    return null;
  } catch {
    // Dialog cancel / plugin unavailable — treat as no selection.
    return null;
  }
}
