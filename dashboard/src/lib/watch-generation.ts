import { createHash } from "node:crypto";

export function watchGenerationKey(
  publicUrl: string,
  watchToken: string,
): string {
  return createHash("sha256")
    .update(publicUrl)
    .update("\0")
    .update(watchToken)
    .digest("base64url");
}
