export function buildWatchProbeUrl(
  publicUrl: string,
  attempt: number,
): string {
  const url = new URL("/styles.css", publicUrl);
  url.searchParams.set("prostar-watch-probe", String(attempt));
  return url.toString();
}
