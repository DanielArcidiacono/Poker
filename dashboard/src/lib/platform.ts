export const AGENT_PLATFORMS = ["macos", "windows", "other"] as const;

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export function normalizeAgentPlatform(value: unknown): AgentPlatform | null {
  return typeof value === "string" &&
    (AGENT_PLATFORMS as readonly string[]).includes(value)
    ? (value as AgentPlatform)
    : null;
}

export function platformDisplayName(
  platform: AgentPlatform | null,
): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  return "Device";
}
