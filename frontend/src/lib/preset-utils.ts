import type { PipelinePreset } from "@/lib/api";

/** Canonicalize a preset config for content comparison: sort keys
 *  recursively and round floats (canvas drags produce microscopic diffs). */
export function presetContentKey(config: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "number") return Math.round(v * 10000) / 10000;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        o[k] = norm((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v ?? null;
  };
  return JSON.stringify(norm(config));
}

/** Find an existing preset with identical content (ignores the name). */
export function findDuplicatePreset(
  presets: PipelinePreset[],
  config: Record<string, unknown>,
): PipelinePreset | null {
  const key = presetContentKey(config);
  for (const p of presets) {
    try {
      if (presetContentKey(p.config as Record<string, unknown>) === key) {
        return p;
      }
    } catch {
      // malformed stored config — skip
    }
  }
  return null;
}
