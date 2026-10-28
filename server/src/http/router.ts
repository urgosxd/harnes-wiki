import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path parameters extracted from the matched route. */
  params: Record<string, string>;
  url: URL;
  /** Authenticated user id. Set by the auth step before any handler runs. */
  userId: string;
  /** Parse the body as JSON under the router's global limit. */
  body(): Promise<unknown>;
  /**
   * Read the body as raw bytes, bounded by the CALLER's limit rather than the
   * router's.
   *
   * Uploads need this: the global limit is sized for JSON, and a document upload is
   * legitimately larger. Sharing `body()` would either force the global limit up
   * for every route (a wider attack surface for all of them) or reject valid
   * uploads. Only one of the two readers may be used per request.
   */
  bodyBytes(limit: number): Promise<Buffer>;
}

export type Handler = (ctx: RequestContext) => Promise<void>;

/** An error that carries the status the client should see. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  patch(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  handle(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void>;
  listen(port: number, host?: string): Promise<Server>;
}

/** `/conversations/:id/turns` -> a regex plus its parameter names. */
function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export function createRouter(options: {
  authenticate: (req: IncomingMessage) => Promise<string | undefined>;
  maxBodyBytes?: number;
}): Router {
  const routes: Route[] = [];
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;

  const add = (method: string, path: string, handler: Handler) => {
    const { pattern, keys } = compile(path);
    routes.push({ method, pattern, keys, handler });
  };

  return {
    get: (path, handler) => add("GET", path, handler),
    post: (path, handler) => add("POST", path, handler),
    patch: (path, handler) => add("PATCH", path, handler),
    delete: (path, handler) => add("DELETE", path, handler),

    async handle(req, res, userId) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = req.method ?? "GET";

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;

        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? "");
        });

        let bodyRead = false;
        // One read per request, and only one: the stream cannot be replayed, and a
        // handler that tried would silently get an empty second read.
        const claimBody = () => {
          if (bodyRead) throw new Error("body already read");
          bodyRead = true;
        };
        const ctx: RequestContext = {
          req,
          res,
          params,
          url,
          userId,
          body: async () => {
            claimBody();
            return readJsonBody(req, maxBodyBytes);
          },
          bodyBytes: async (limit: number) => {
            claimBody();
            return readRawBody(req, limit);
          },
        };

        try {
          await route.handler(ctx);
        } catch (error) {
          // A handler that already started streaming cannot switch to an error
          // status; close the stream instead of leaving it hanging.
          if (res.headersSent) {
            res.end();
            return;
          }
          if (error instanceof HttpError) {
            sendJson(res, error.status, { error: error.code, message: error.message });
            return;
          }
          sendJson(res, 500, { error: "internal_error", message: messageOf(error) });
        }
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    },

    async listen(port, host = "127.0.0.1") {
      const server = createServer((req, res) => {
        void options
          .authenticate(req)
          .then(async (userId) => {
            // Liveness is deliberately public: a healthcheck that needs a user
            // token couples container health to a secret.
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            if (!userId && path !== "/health" && !isCapabilityPath(path)) {
              sendJson(res, 401, { error: "unauthorized" });
              return;
            }
            await this.handle(req, res, userId ?? "");
          })
          .catch((error: unknown) => {
            if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: messageOf(error) });
            else res.end();
          });
      });
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      return server;
    },
  };
}

/**
 * Paths that authorise themselves instead of carrying an identity.
 *
 * A capability URL is handed to another service that holds no credential of ours,
 * so requiring one would make the handoff impossible. The path is public by
 * construction and protected by its own secret; see `api/document-routes.ts`.
 *
 * Kept as an explicit allowlist rather than a prefix check on the whole API: any
 * future exception has to be added here on purpose.
 */
function isCapabilityPath(pathname: string): boolean {
  // /documents/<id>/<secret>/<filename>
  return /^\/documents\/[^/]+\/[^/]+\/[^/]+$/.test(pathname);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      // A typed error so the handler can answer 413 instead of a generic 500.
      throw new HttpError(413, "body_too_large", `request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}
