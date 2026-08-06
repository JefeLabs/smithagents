import { isTauri } from "@tauri-apps/api/core";

/** True only inside the Tauri shell — the shared bundle must keep working in a plain browser (README's zero-Tauri-APIs rule). */
export function hasNativeFolderPicker(): boolean {
  return isTauri();
}

/** Native OS folder dialog. Resolves the picked absolute path, or null on cancel / outside Tauri. Dynamic import keeps the plugin out of the browser/jsdom bundle. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}
