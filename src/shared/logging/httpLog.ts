import { Request, Response, NextFunction } from "express";

/**
 * HTTP access logging middleware.
 *
 * Logs one structured JSON line per request on response finish:
 *   scope, method, url, status, durationMs, ip, ua
 *
 * Deliberately omits: Authorization, Cookie, request body, passwords.
 * Safe to use in production — no sensitive data captured.
 */
export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const ua = req.headers["user-agent"] ?? "unknown";

    console.log(
      JSON.stringify({
        scope: "http",
        at: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs,
        ip,
        ua,
      })
    );
  });

  next();
}
