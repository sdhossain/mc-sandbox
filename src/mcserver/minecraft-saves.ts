import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Minecraft Launcher's folder on this platform. */
export function launcherDirectory(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "minecraft");
  }
  if (platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), ".minecraft");
  }
  return join(home, ".minecraft");
}

/**
 * The `saves` folder singleplayer worlds are opened from: the game folder of the launcher profile used
 * most recently (profiles can point to their own folder), or the launcher's default.
 */
export function savesDirectory(launcherDir: string = launcherDirectory()): string {
  try {
    const { profiles } = JSON.parse(readFileSync(join(launcherDir, "launcher_profiles.json"), "utf8")) as {
      profiles?: Record<string, { gameDir?: string; lastUsed?: string }>;
    };
    const recent = Object.values(profiles ?? {})
      .filter((profile) => profile.gameDir !== undefined && profile.gameDir !== "")
      .sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""))[0];
    if (recent?.gameDir !== undefined) {
      return join(recent.gameDir, "saves");
    }
  } catch {
    // No launcher profiles: use the default folder.
  }
  return join(launcherDir, "saves");
}
