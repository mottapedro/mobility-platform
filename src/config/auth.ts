const DEFAULT_JWT_ISSUER = "mobility-platform-backend";
const DEFAULT_JWT_AUDIENCE = "mobility-platform-clients";
const DEFAULT_ACCESS_TOKEN_TTL = "15m";
const DEFAULT_REFRESH_TOKEN_TTL = "30d";
const MINIMUM_JWT_SECRET_BYTES = 32;

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

export interface AuthConfig {
  jwtSecret: Uint8Array;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlMs: number;
}

function requiredNonBlank(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

export function parseDurationSeconds(value: string, name: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`${name} must use a positive duration such as 15m or 30d`);
  }

  const amount = Number(match[1]);
  const multiplier = UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  const seconds = amount * multiplier;

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive safe duration`);
  }

  return seconds;
}

export function loadRefreshTokenTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parseDurationSeconds(
      env.REFRESH_TOKEN_TTL ?? DEFAULT_REFRESH_TOKEN_TTL,
      "REFRESH_TOKEN_TTL",
    ) * 1_000
  );
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const secretText = requiredNonBlank(env.JWT_SECRET, "JWT_SECRET");
  const jwtSecret = new TextEncoder().encode(secretText);

  if (jwtSecret.byteLength < MINIMUM_JWT_SECRET_BYTES) {
    throw new Error(
      `JWT_SECRET must contain at least ${MINIMUM_JWT_SECRET_BYTES} bytes`,
    );
  }

  const jwtIssuer = requiredNonBlank(
    env.JWT_ISSUER ?? DEFAULT_JWT_ISSUER,
    "JWT_ISSUER",
  );
  const jwtAudience = requiredNonBlank(
    env.JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE,
    "JWT_AUDIENCE",
  );
  const accessTokenTtlSeconds = parseDurationSeconds(
    env.ACCESS_TOKEN_TTL ?? DEFAULT_ACCESS_TOKEN_TTL,
    "ACCESS_TOKEN_TTL",
  );
  const refreshTokenTtlMs = loadRefreshTokenTtlMs(env);

  return {
    jwtSecret,
    jwtIssuer,
    jwtAudience,
    accessTokenTtlSeconds,
    refreshTokenTtlMs,
  };
}
