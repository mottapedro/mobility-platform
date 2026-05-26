type LogContext = Record<string, unknown>;

export function logInfo(event: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ ...context, level: "info", event }));
}

export function logError(event: string, error: unknown, context: LogContext = {}): void {
  console.error(JSON.stringify({
    ...context,
    level: "error",
    event,
    message: error instanceof Error ? error.message : String(error),
  }));
}