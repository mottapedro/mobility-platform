import { jwtVerify, SignJWT } from "jose";
import { AuthConfig, loadAuthConfig } from "../../config/auth";

const ACCESS_TOKEN_ALGORITHM = "HS256";

export interface IssueAccessTokenInput {
  userId: string;
  sessionId: string;
}

export interface VerifiedAccessToken {
  sub: string;
  sid: string;
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
}

export class AuthTokenService {
  constructor(
    private readonly config: AuthConfig = loadAuthConfig(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueAccessToken(input: IssueAccessTokenInput): Promise<string> {
    if (!input.userId || !input.sessionId) {
      throw new Error("userId and sessionId are required to issue an access token");
    }

    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const expiresAt = issuedAt + this.config.accessTokenTtlSeconds;

    return new SignJWT({ sid: input.sessionId })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: "JWT" })
      .setSubject(input.userId)
      .setIssuer(this.config.jwtIssuer)
      .setAudience(this.config.jwtAudience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.config.jwtSecret);
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    if (!token) {
      throw new Error("access token is required");
    }

    const { payload, protectedHeader } = await jwtVerify(
      token,
      this.config.jwtSecret,
      {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        currentDate: this.now(),
      },
    );

    if (protectedHeader.alg !== ACCESS_TOKEN_ALGORITHM) {
      throw new Error("unexpected access token algorithm");
    }

    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.iss !== "string" ||
      (typeof payload.aud !== "string" && !Array.isArray(payload.aud)) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("access token is missing required claims");
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      iss: payload.iss,
      aud: payload.aud,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
