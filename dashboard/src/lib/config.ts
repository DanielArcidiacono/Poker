export function getDashboardPassword(): string {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (
    !password ||
    password === "change-me" ||
    password === "replace-with-a-strong-password" ||
    password.length < 12
  ) {
    throw new Error(
      "DASHBOARD_PASSWORD must be at least 12 characters and cannot be 'change-me'",
    );
  }
  return password;
}

export function getAgentToken(): string {
  const token =
    process.env.PROSTAR_ENROLLMENT_SECRET?.trim() ||
    process.env.AGENT_TOKEN?.trim();
  if (
    !token ||
    token === "generate-at-least-32-random-characters" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token)
  ) {
    throw new Error(
      "PROSTAR_ENROLLMENT_SECRET must contain 32–256 URL-safe characters",
    );
  }
  return token;
}
