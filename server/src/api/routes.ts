import { randomUUID } from "node:crypto";
import type { Router, RequestContext } from "../http/router.ts";
import { HttpError, sendJson } from "../http/router.ts";
import { encodeFrame } from "../pi/events.ts";
import { withStackContext } from "../pi/stack-context.ts";
import type { ConversationStore } from "../db/conversation-store.ts";
import type { Database } from "../db/pool.ts";
import type { AuthMode } from "../http/auth.ts";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from "../http/passwords.ts";
import { USER_ID_PATTERN } from "../db/seed-users.ts";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  createSession,
  deleteSession,
  parseCookies,
  serializeSessionCookie,
} from "../http/sessions.ts";
import type { TurnService } from "./turn-service.ts";

export interface RouteDeps {
  store: ConversationStore;
  turns: TurnService;
  /**
   * Accounts and sessions, when this server has them.
   *
   * Optional because suites that exercise only the legacy identity modes register these
   * routes with no database at all; `main.ts` always passes one. Without it, login and
   * logout are not registered and `/me` falls back to the legacy display name.
   */
  db?: Database | undefined;
  /**
   * Origin this server is reached at, from `config.publicBaseUrl`.
   *
   * Used for one decision only: whether the session cookie is `Secure`. Read here as a
   * value, so this module never consults the environment or the config loader.
   */
  publicBaseUrl?: string | undefined;
  /**
   * The mode identity is resolved with, when the caller knows it.
   *
   * Read for one question only: whether a caller's display name may come from an account
   * row. Under the legacy modes identity is a claimed header value, so the id IS the whole
   * truth about that caller and `/me` keeps answering it — a header that happens to match
   * an existing account must not start leaking that account's name.
   */
  authMode?: AuthMode | undefined;
}

interface CreateBody {
  title?: unknown;
}

interface TurnBody {
  message?: unknown;
}

interface LoginBody {
  user?: unknown;
  password?: unknown;
}

interface CreateUserBody {
  user?: unknown;
  password?: unknown;
  displayName?: unknown;
}

/**
 * Longest display name the endpoint accepts.
 *
 * The column has no bound of its own, so this route is the only place the length of a name
 * is decided. A bound exists at all because a name is rendered: an unbounded one is a
 * layout somebody else has to survive.
 */
const MAX_DISPLAY_NAME_LENGTH = 120;

/**
 * The Stack this turn must read, as the page named it.
 *
 * A SELECTION, never an authorisation: no entitlement is derived from it, nothing
 * is stored with the conversation, and under `AUTH_MODE=open` any caller could set
 * it — the same caller can already claim any `x-user-id`. Its only job is to say
 * which Stack the agent's Stack-scoped tools should read, so that no tool call has
 * to fall back to a Stack this deployment guessed.
 *
 * Absent and blank are the same fact — no Stack — and the tools then fail closed
 * with a visible error instead of reading something nobody chose.
 */
function requestStackId(ctx: RequestContext): string | undefined {
  const header = ctx.req.headers["x-stack-id"];
  // Two lines, or a value Node joined from two lines, is an AMBIGUOUS request: no
  // context. Taking the first half would let a malformed request pick somebody's
  // Stack, and a Stack is precisely what must never be guessed. Refusing costs one
  // visible tool error; guessing costs a cross-tenant read.
  if (Array.isArray(header)) return undefined;
  const raw = header?.trim();
  if (!raw) return undefined;
  if (raw.includes(",")) return undefined;
  return raw;
}

function requireMessage(body: unknown): string {
  const message = (body as TurnBody | undefined)?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new HttpError(400, "invalid_message", "message must be a non-empty string");
  }
  if (message.length > 32_000) {
    throw new HttpError(400, "invalid_message", "message is too long");
  }
  return message;
}

export function registerRoutes(router: Router, deps: RouteDeps): void {
  const { store, turns, db } = deps;

  // Whether the browser is talking to us over TLS. Only the cookie uses it, and it is
  // computed once: reading it per request would be a second source of truth.
  const cookiesSecure = (deps.publicBaseUrl ?? "").startsWith("https");

  // One throttle for this server's process, shared by every login attempt it serves.
  const throttle = new LoginThrottle();

  /**
   * The name to show for a user id.
   *
   * In password mode the account is the source of truth. Everywhere else the id is: a
   * legacy `user_id` can be any header value with no account behind it, and those modes
   * must keep answering exactly what they answered before. Falling back to the id inside
   * password mode covers a row deleted between the session lookup and this handler, which
   * is the only way that branch is reached.
   */
  const displayNameFor = async (userId: string): Promise<string> => {
    if (!db || deps.authMode !== "password") return userId;
    const rows = await db.query<{ display_name: string }>(
      "SELECT display_name FROM users WHERE id = $1",
      [userId],
    );
    return rows[0]?.display_name ?? userId;
  };

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  // Liveness only: no data, no credentials. Kept unauthenticated so a container
  // healthcheck does not depend on holding a user token.
  router.get("/health", async ({ res }) => {
    sendJson(res, 200, { ok: true });
  });

  /**
   * Who the caller is.
   *
   * The client needs this to show "signed in as alice" without keeping the token in
   * a place it can be read back, and to prove that a link carried the right secret
   * rather than only the right name.
   *
   * The shape is frozen: `{ id, displayName }` at the top level, because the web client
   * and its tests read exactly those fields. What changes in password mode is only where
   * the name comes from — the account row, not the id echoed back.
   */
  router.get("/me", async ({ res, userId }) => {
    sendJson(res, 200, { id: userId, displayName: await displayNameFor(userId) });
  });

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  if (db) {
    /**
     * A password hash that belongs to no account, verified when the user does not exist.
     *
     * Without it, an unknown name answers as fast as a string comparison while a real one
     * pays for scrypt — a timing difference that tells an attacker which accounts exist
     * before any password is guessed. Computed once, on first use, because a boot that
     * hashed it eagerly would pay for it even under the legacy modes.
     */
    let dummyHash: Promise<string> | undefined;
    const timingEqualiser = (): Promise<string> => {
      dummyHash ??= hashPassword("dummy-password-for-timing-not-an-account");
      return dummyHash;
    };

    /**
     * Sign in with a user name and a password.
     *
     * Every refusal is deliberate about what it reveals: a missing field is a `400` (the
     * request is wrong, which the caller already knows), a locked account is a `429` (a
     * fact about their own account, and the only way they can learn to wait), and an
     * unknown user answers exactly what a wrong password answers — one body, one status,
     * the same amount of work — so the endpoint cannot be used to enumerate accounts.
     */
    router.post("/login", async (ctx) => {
      const body = (await ctx.body()) as LoginBody | undefined;
      const userId = typeof body?.user === "string" ? body.user.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!userId || !password.trim()) {
        throw new HttpError(400, "invalid_request", "user and password are required");
      }

      // Before the lookup: a locked account must not be a free password oracle just
      // because the guess is wrong.
      if (throttle.isLocked(userId)) {
        throw new HttpError(429, "too_many_attempts", "Too many failed attempts; try again later");
      }

      const rows = await db.query<{ id: string; display_name: string; password_hash: string }>(
        "SELECT id, display_name, password_hash FROM users WHERE id = $1",
        [userId],
      );
      const account = rows[0];

      // Always verify: against the stored hash when the account exists, against the
      // dummy one when it does not, so both paths cost one scrypt and one refusal.
      const matches = await verifyPassword(
        password,
        account?.password_hash ?? (await timingEqualiser()),
      );

      if (!account || !matches) {
        throttle.recordFailure(userId);
        throw new HttpError(401, "invalid_credentials", "User or password is incorrect");
      }

      throttle.reset(userId);
      const session = await createSession(db, account.id);
      ctx.res.setHeader(
        "set-cookie",
        serializeSessionCookie(session.token, {
          secure: cookiesSecure,
          maxAgeSeconds: SESSION_TTL_MS / 1000,
        }),
      );
      sendJson(ctx.res, 200, {
        user: { id: account.id, displayName: account.display_name },
      });
    });

    /**
     * Sign out.
     *
     * Always `204` and always a clearing cookie, whatever arrived: no cookie, a cookie for
     * a session that is already gone, or a token this server never issued. Signing out is
     * not something a client should have to succeed at twice, and an error here would
     * leave a browser holding a cookie it cannot drop.
     */
    router.post("/logout", async ({ req, res }) => {
      const raw = req.headers.cookie;
      const token = parseCookies(Array.isArray(raw) ? raw[0] : raw)[SESSION_COOKIE];
      if (token) await deleteSession(db, token);

      res.writeHead(204, { "set-cookie": clearSessionCookie({ secure: cookiesSecure }) });
      res.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  if (db) {
    /**
     * Create an account.
     *
     * Anyone signed in may do it (S4), and that is the whole authorization story: there is
     * no role, no admin flag and no privileged account, so the creator is not recorded as
     * the owner of anything (S6). The account it creates is an ordinary account — same
     * permissions as whoever created it, and its own rows and nobody else's.
     *
     * The id rule is the one `users.id` enforces in the database. Checking it here is what
     * turns a rejected id into a `400` the client can read instead of the `500` a violated
     * CHECK constraint would produce.
     *
     * A duplicate is answered from the INSERT's unique violation and never from a SELECT
     * first: two requests for the same id can both find it missing, and only the database
     * can decide which one wins. With the decision inside the insert, the loser answers
     * `409` and the row that already exists is not touched — a duplicate must never be a
     * silent password reset.
     *
     * ## An id that already OWNS data is refused
     *
     * `conversations`, `tenant_mcp` and `tenant_scopes` are keyed by a text `user_id` with
     * no foreign key, on purpose: a deployment coming from a header mode has rows whose id
     * is not an account yet. Under `AUTH_MODE=open` a name in a header IS the identity, so
     * "becoming" such an id was never a privilege — everybody could claim it already. Under
     * a password it is one: the first caller to create that id would sign in as the owner of
     * somebody else's existing conversations, servers and scopes. So the id is refused with
     * `409 user_reserved` and stays unclaimed.
     *
     * The one deliberate exception is NOT here, and it is not a caller's action: see
     * `seedDefaultUsers`, which still seeds `alice` and `bob` over pre-existing rows. That is
     * a deployment's migration path, run by the operator at boot, and it is the only place
     * that may adopt rows nobody's account owns.
     */
    router.post("/users", async (ctx) => {
      const body = (await ctx.body()) as CreateUserBody | undefined;

      const userId = typeof body?.user === "string" ? body.user.trim() : "";
      if (!USER_ID_PATTERN.test(userId)) {
        throw new HttpError(
          400,
          "invalid_request",
          "user must match [A-Za-z0-9._@-] and be at most 64 characters",
        );
      }

      // Never trimmed: spaces inside a password are part of it, and the bounds are the
      // hashing module's, so this route cannot accept one it would refuse to hash.
      const password = typeof body?.password === "string" ? body.password : "";
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          "invalid_request",
          `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
        );
      }

      // Optional, and the id is its own default: a client that only cares about the id
      // should not have to send a name. Blank is treated as absent, because a name made of
      // spaces is not a name.
      const requestedName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
      if (requestedName.length > MAX_DISPLAY_NAME_LENGTH) {
        throw new HttpError(
          400,
          "invalid_request",
          `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
        );
      }
      const displayName = requestedName || userId;

      const passwordHash = await hashPassword(password);
      try {
        await db.transaction(async (tx) => {
          // The insert runs FIRST so that an id which is both an account and an owner of
          // rows answers `user_exists`: an existing account is the more specific fact, and
          // the unique violation is the only decision a concurrent request cannot beat.
          await tx.query("INSERT INTO users (id, display_name, password_hash) VALUES ($1, $2, $3)", [
            userId,
            displayName,
            passwordHash,
          ]);

          // One question, three columns that already exist: "owns data" is exactly what
          // `conversations`, `tenant_mcp` and `tenant_scopes` already say, so the rule needs
          // no new table and no new column.
          const [ownership] = await tx.query<{ reserved: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM conversations WHERE user_id = $1)
                 OR EXISTS (SELECT 1 FROM tenant_mcp WHERE user_id = $1)
                 OR EXISTS (SELECT 1 FROM tenant_scopes WHERE user_id = $1) AS reserved`,
            [userId],
          );
          if (ownership?.reserved) {
            throw new HttpError(
              409,
              "user_reserved",
              `User "${userId}" is reserved: it already owns data in this deployment`,
            );
          }
          // The check shares the insert's transaction, so a reserved id leaves no account
          // behind: the row written above is rolled back together with the refusal.
        });
      } catch (error) {
        // Raised by the insert, which runs before the ownership check, so an id that is both
        // an account and an owner lands here: `user_exists` is the more specific fact. Any
        // other error, including the `user_reserved` above, is re-thrown as itself.
        if (isUniqueViolation(error)) {
          throw new HttpError(409, "user_exists", `User "${userId}" already exists`);
        }
        throw error;
      }

      sendJson(ctx.res, 201, { user: { id: userId, displayName } });
    });
  }

  router.get("/conversations", async ({ res, userId }) => {
    const list = await store.listForUser(userId);
    sendJson(res, 200, {
      conversations: list.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  });

  router.post("/conversations", async (ctx) => {
    const body = (await ctx.body()) as CreateBody | undefined;
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;

    const conversation = await store.create({
      id: randomUUID(),
      userId: ctx.userId,
      piSessionId: randomUUID(),
      title,
    });
    sendJson(ctx.res, 201, toConversationJson(conversation));
  });

  router.get("/conversations/:id", async ({ res, params, userId }) => {
    const conversation = await store.findOwned(params.id ?? "", userId);
    // A foreign conversation answers exactly like a missing one. Distinguishing
    // them would confirm that someone else's conversation exists.
    if (!conversation) return sendJson(res, 404, { error: "not_found" });

    const entries = await store.read(conversation.id);
    sendJson(res, 200, {
      ...toConversationJson(conversation),
      // The client renders this projection; it never sees Pi session internals.
      messages: projectMessages(entries),
    });
  });

  router.patch("/conversations/:id", async (ctx) => {
    const body = (await ctx.body()) as CreateBody | undefined;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) throw new HttpError(400, "invalid_title", "title must be a non-empty string");

    const renamed = await store.rename(ctx.params.id ?? "", ctx.userId, title);
    if (!renamed) return sendJson(ctx.res, 404, { error: "not_found" });
    sendJson(ctx.res, 200, toConversationJson(renamed));
  });

  router.delete("/conversations/:id", async ({ res, params, userId }) => {
    const archived = await store.archive(params.id ?? "", userId);
    if (!archived) return sendJson(res, 404, { error: "not_found" });
    res.writeHead(204);
    res.end();
  });

  // ---------------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------------

  router.post("/conversations/:id/turns", async (ctx) => {
    const body = await ctx.body();
    const message = requireMessage(body);

    const header = ctx.req.headers["idempotency-key"];
    // Without a key a reconnect would start a second run. Refusing is safer than
    // guessing: the client must say which turn it means.
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey || !/^[\w.:-]{1,200}$/.test(idempotencyKey)) {
      return sendJson(ctx.res, 400, {
        error: "idempotency_key_required",
        message: "send an Idempotency-Key header unique to this turn",
      });
    }

    await withStackContext(requestStackId(ctx), async () => {
      const started = await turns.start({
        userId: ctx.userId,
        conversationId: ctx.params.id ?? "",
        message,
        idempotencyKey,
      });

      switch (started.kind) {
        case "not_found":
          return sendJson(ctx.res, 404, { error: "not_found" });
        case "busy":
          return sendJson(ctx.res, 409, {
            error: "turn_in_progress",
            runId: started.running?.id ?? null,
            message: "this conversation already has a running turn",
          });
        case "replayed":
          return sendJson(ctx.res, 200, {
            error: "duplicate_turn",
            runId: started.run.id,
            status: started.run.status,
            message: "this idempotency key was already used",
          });
        case "started":
          return streamFrames(ctx, started.runId, started.frames);
      }
    });
  });
}

/** Serve the turn's frames as Server-Sent Events. */
async function streamFrames(
  ctx: RequestContext,
  runId: string,
  frames: AsyncIterable<import("../pi/events.ts").ChatFrame>,
): Promise<void> {
  ctx.res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Proxies that buffer would turn live streaming into one late burst.
    "x-accel-buffering": "no",
    "x-run-id": runId,
  });
  // Tell the client which run this is before any model work happens.
  ctx.res.write(": connected\n\n");

  let clientGone = false;
  ctx.req.on("close", () => {
    clientGone = true;
  });

  try {
    for await (const frame of frames) {
      if (clientGone) break;
      ctx.res.write(encodeFrame(frame));
    }
  } finally {
    ctx.res.end();
  }
}

/**
 * Whether this error is Postgres refusing a duplicate key (SQLSTATE 23505).
 *
 * Read through the error's `code` rather than by importing the driver's error class, so a
 * wrapped or re-thrown error is still recognised for the one fact that matters: the
 * database already has that id.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function toConversationJson(conversation: {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

/**
 * Reduce Pi entries to what a chat window renders.
 *
 * The transcript holds model changes, thinking-level changes, system messages and
 * tool results. None of those belong in a chat bubble, and none of them are
 * meaningful without Pi's own renderers.
 */
export function projectMessages(
  entries: readonly { type: string; message?: { role?: string; content?: unknown } }[],
): Array<{ id: string; role: "user" | "assistant"; text: string }> {
  const messages: Array<{ id: string; role: "user" | "assistant"; text: string }> = [];
  let index = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(entry.message?.content);
    if (!text) continue;
    messages.push({ id: `m${index}`, role, text });
    index += 1;
  }

  return messages;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("");
}


