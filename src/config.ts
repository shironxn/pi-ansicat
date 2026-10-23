// ansicat.json lives in the agent dir; the legacy ~/.pi path is still read.
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.length > 0) {
    // pi expands a leading ~ itself; match it so paths do not diverge.
    return env.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  }
  return `${process.env.HOME ?? ""}/.pi/agent`;
}

export function ansicatConfigPaths(): [current: string, legacy: string] {
  return [`${agentDir()}/ansicat.json`, `${process.env.HOME ?? ""}/.pi/ansicat.json`];
}

export interface VisionSettings {
  provider: string;
  model: string;
  prompt?: string;
  maxTokens?: number;
  /** `disk` survives sessions; the default keeps descriptions in memory only. */
  cache?: "session" | "disk";
}

// Hand-edited JSON: keep the documented scalars and drop anything else, so a
// typo cannot reach the provider call or crash describePrompt.
export function normalizeVisionSettings(value: unknown): VisionSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (provider.length === 0 || model.length === 0) return undefined;
  const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
  const maxTokens =
    typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0
      ? Math.floor(raw.maxTokens)
      : undefined;
  return {
    provider,
    model,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(raw.cache === "disk" ? { cache: "disk" as const } : {}),
  };
}
