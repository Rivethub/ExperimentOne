import { isString } from "./guards";

export async function pickRivetbag(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Rivet captures", extensions: ["rivetbag"] }],
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
