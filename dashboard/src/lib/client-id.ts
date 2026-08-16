export const LEGACY_CLIENT_ID = "00000000-0000-4000-8000-000000000000";
export const LEGACY_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";

const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return CLIENT_ID.test(normalized) ? normalized : null;
}
