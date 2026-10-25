/**
 * Structured logs: one JSON object per line.
 *
 * Plain text lines are unreadable once several users run at once, and a log line
 * that cannot be filtered by run id or user is a log line nobody uses during an
 * incident. Fields are fixed so `jq` queries stay stable.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly minimum: number;
  private readonly sink: (line: string) => void;

  constructor(options: { level?: LogLevel; sink?: (line: string) => void } = {}) {
    this.minimum = LEVEL_ORDER[options.level ?? "info"];
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  child(base: LogFields): Logger {
    const parent = this;
    const wrapped = new Logger({ level: "debug", sink: (line) => parent.sink(line) });
    // Preserve the parent's threshold while prefixing every record.
    return Object.assign(wrapped, {
      emit: (level: LogLevel, message: string, fields: LogFields) =>
        parent.emit(level, message, { ...base, ...fields }),
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit("error", message, fields);
  }

  emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < this.minimum) return;
    // Secrets must never reach a log. Keys are matched by name, values are not
    // inspected, so a token inside a free-form message is still the caller's
    // responsibility.
    const safe = redact(fields);
    this.sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        message,
        ...safe,
      }),
    );
  }
}

const SECRET_KEY = /token|secret|password|authorization|apikey|api_key|credential/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = redact(value as LogFields);
      continue;
    }
    out[key] = value;
  }
  return out;
}
