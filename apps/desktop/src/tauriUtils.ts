export async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
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
    if (typeof selected === "string") return selected;
    if (Array.isArray(selected) && selected[0]) return selected[0];
    return null;
  } catch {
    return null;
  }
}
