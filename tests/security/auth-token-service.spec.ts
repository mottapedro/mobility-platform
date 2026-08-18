import { SignJWT } from "jose";
import { AuthConfig, loadAuthConfig } from "../../src/config/auth";
import { AuthTokenService } from "../../src/domain/auth/AuthTokenService";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const SECRET = new TextEncoder().encode("a".repeat(32));

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtSecret: SECRET,
    jwtIssuer: "mobility-platform-backend",
    jwtAudience: "mobility-platform-clients",
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

describe("AuthTokenService", () => {
  it("issues and verifies an HS256 access token with canonical claims", async () => {
    const service = new AuthTokenService(config(), () => NOW);

    const token = await service.issueAccessToken({
      userId: "user-123",
      sessionId: "session-456",
    });
    const claims = await service.verifyAccessToken(token);

    expect(claims).toMatchObject({
      sub: "user-123",
      sid: "session-456",
      iss: "mobility-platform-backend",
      aud: "mobility-platform-clients",
      iat: Math.floor(NOW.getTime() / 1_000),
      exp: Math.floor(NOW.getTime() / 1_000) + 15 * 60,
    });
  });

  it("rejects a malformed access token", async () => {
    const service = new AuthTokenService(config(), () => NOW);
    await expect(service.verifyAccessToken("not-a-jwt")).rejects.toThrow();
  });

  it("rejects an expired access token", async () => {
    const issuer = new AuthTokenService(
      config({ accessTokenTtlSeconds: 1 }),
      () => NOW,
    );
    const token = await issuer.issueAccessToken({
      userId: "user-expired",
      sessionId: "session-expired",
    });
    const verifier = new AuthTokenService(
      config({ accessTokenTtlSeconds: 1 }),
      () => new Date(NOW.getTime() + 2_000),
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects an incorrect issuer", async () => {
    const token = await new AuthTokenService(config(), () => NOW).issueAccessToken({
      userId: "user-issuer",
      sessionId: "session-issuer",
    });
    const verifier = new AuthTokenService(
      config({ jwtIssuer: "other-issuer" }),
      () => NOW,
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects an incorrect audience", async () => {
    const token = await new AuthTokenService(config(), () => NOW).issueAccessToken({
      userId: "user-audience",
      sessionId: "session-audience",
    });
    const verifier = new AuthTokenService(
      config({ jwtAudience: "other-audience" }),
      () => NOW,
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects an invalid signature", async () => {
    const token = await new AuthTokenService(config(), () => NOW).issueAccessToken({
      userId: "user-signature",
      sessionId: "session-signature",
    });
    const verifier = new AuthTokenService(
      config({ jwtSecret: new TextEncoder().encode("b".repeat(32)) }),
      () => NOW,
    );

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects an unexpected signing algorithm", async () => {
    const issuedAt = Math.floor(NOW.getTime() / 1_000);
    const token = await new SignJWT({ sid: "session-algorithm" })
      .setProtectedHeader({ alg: "HS384", typ: "JWT" })
      .setSubject("user-algorithm")
      .setIssuer("mobility-platform-backend")
      .setAudience("mobility-platform-clients")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(SECRET);

    const verifier = new AuthTokenService(config(), () => NOW);
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("fails fast when JWT_SECRET is absent or shorter than 32 bytes", () => {
    expect(() => loadAuthConfig({})).toThrow("JWT_SECRET must be configured");
    expect(() => loadAuthConfig({ JWT_SECRET: "too-short" })).toThrow(
      "JWT_SECRET must contain at least 32 bytes",
    );
  });
});
