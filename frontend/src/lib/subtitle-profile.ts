import fs from "fs";
import os from "os";
import path from "path";

/**
 * Chrome profiles for the Douyin and ChatGPT flows.
 *
 * Default: a single shared profile dir (cùng 1 profile), overridable with
 * SUBTITLE_PROFILE_DIR. Per-service overrides: DOUYIN_PROFILE_DIR /
 * CHATGPT_PROFILE_DIR env vars, or values saved in the settings page
 * (stored in PROFILE_CONFIG_FILE).
 */
export const DEFAULT_PROFILE_DIR =
  process.env.SUBTITLE_PROFILE_DIR ||
  path.join(os.homedir(), ".subtitle-profile");

export const PROFILE_CONFIG_FILE =
  process.env.PROFILE_CONFIG_FILE ||
  path.join(os.homedir(), ".subtitle-profiles.json");

export type ProfileConfig = {
  douyin?: string;
  chatgpt?: string;
};

export function readProfileConfig(): ProfileConfig {
  try {
    if (!fs.existsSync(PROFILE_CONFIG_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(PROFILE_CONFIG_FILE, "utf8"));
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

export function writeProfileConfig(cfg: ProfileConfig): void {
  fs.mkdirSync(path.dirname(PROFILE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(PROFILE_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export function resolveProfileDir(service: "douyin" | "chatgpt"): string {
  const envVar =
    service === "douyin" ? "DOUYIN_PROFILE_DIR" : "CHATGPT_PROFILE_DIR";
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const fromCfg = readProfileConfig()[service];
  if (fromCfg) return fromCfg;
  return DEFAULT_PROFILE_DIR;
}

export function getProfileDir(service: "douyin" | "chatgpt"): string {
  return resolveProfileDir(service);
}
