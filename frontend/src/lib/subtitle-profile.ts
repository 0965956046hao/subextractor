import fs from "fs";
import os from "os";
import path from "path";

/**
 * Chrome profiles for the Douyin, ChatGPT and Gemini flows.
 *
 * Default: a single shared profile dir (cùng 1 profile), overridable with
 * SUBTITLE_PROFILE_DIR. Per-service overrides: DOUYIN_PROFILE_DIR /
 * CHATGPT_PROFILE_DIR / GEMINI_PROFILE_DIR env vars, or values saved in the
 * settings page (stored in PROFILE_CONFIG_FILE).
 */
export const DEFAULT_PROFILE_DIR =
  process.env.SUBTITLE_PROFILE_DIR ||
  path.join(os.homedir(), ".subtitle-profile");

export const PROFILE_CONFIG_FILE =
  process.env.PROFILE_CONFIG_FILE ||
  path.join(os.homedir(), ".subtitle-profiles.json");

export type ProfileService = "douyin" | "chatgpt" | "gemini";

export type ProfileConfig = {
  douyin?: string;
  chatgpt?: string;
  gemini?: string;
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

const PROFILE_ENV_VARS: Record<ProfileService, string> = {
  douyin: "DOUYIN_PROFILE_DIR",
  chatgpt: "CHATGPT_PROFILE_DIR",
  gemini: "GEMINI_PROFILE_DIR",
};

export function resolveProfileDir(service: ProfileService): string {
  const fromEnv = process.env[PROFILE_ENV_VARS[service]];
  if (fromEnv) return fromEnv;
  const fromCfg = readProfileConfig()[service];
  if (fromCfg) return fromCfg;
  return DEFAULT_PROFILE_DIR;
}

export function getProfileDir(service: ProfileService): string {
  return resolveProfileDir(service);
}
