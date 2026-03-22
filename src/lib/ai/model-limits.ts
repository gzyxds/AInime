export const MODEL_MAX_DURATIONS: Record<string, number> = {
  "veo-2.0-generate-001": 8,
  "veo-3.0-generate-001": 8,
  "veo-3.0-fast-generate-001": 8,
  "veo-3.1-generate-001": 8,
  "veo-3.1-fast-generate-001": 8,
  "kling-v1": 10,
  "kling-v1-5": 10,
  "kling-v2.5-turbo": 10,
  "kling-v3": 15,
  "doubao-seedance-1-5-pro-250528": 12,
  "doubao-seedance-1-5-pro-251215": 12,
  "doubao-seedance-1-0-lite-250528": 5,
};

export const DEFAULT_MAX_DURATION = 12;

/** Returns the maximum supported video duration (seconds) for the given model ID. Unknown models return 12. */
export function getModelMaxDuration(modelId?: string | null): number {
  if (!modelId) return DEFAULT_MAX_DURATION;

  const lowerModelId = modelId.toLowerCase();

  if (lowerModelId in MODEL_MAX_DURATIONS) {
    return MODEL_MAX_DURATIONS[lowerModelId];
  }

  for (const key of Object.keys(MODEL_MAX_DURATIONS).sort((a, b) => b.length - a.length)) {
    if (lowerModelId.startsWith(key) || key.startsWith(lowerModelId)) {
      return MODEL_MAX_DURATIONS[key];
    }
  }

  return DEFAULT_MAX_DURATION;
}
