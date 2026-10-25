import { randomUUID } from "node:crypto";
import type { Router, RequestContext } from "../http/router.ts";
import { HttpError, sendJson } from "../http/router.ts";
import { encodeFrame } from "../pi/events.ts";
import type { ConversationStore } from "../db/conversation-store.ts";
import type { TurnService } from "./turn-service.ts";

export interface RouteDeps {
  store: ConversationStore;
  turns: TurnService;
}

interface CreateBody {
  title?: unknown;
}

interface TurnBody {
  message?: unknown;
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
  const { store, turns } = deps;

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  router.get("/health", async ({ res }) => {
    sendJson(res, 200, { ok: true });
  });

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

    const outcome = await turns.start({
      userId: ctx.userId,
      conversationId: ctx.params.id ?? "",
      message,
      idempotencyKey,
    });

    switch (outcome.kind) {
      case "not_found":
        return sendJson(ctx.res, 404, { error: "not_found" });
      case "busy":
        return sendJson(ctx.res, 409, {
          error: "turn_in_progress",
          runId: outcome.running?.id ?? null,
          message: "this conversation already has a running turn",
        });
      case "replayed":
        return sendJson(ctx.res, 200, {
          error: "duplicate_turn",
          runId: outcome.run.id,
          status: outcome.run.status,
          message: "this idempotency key was already used",
        });
      case "started":
        return streamFrames(ctx, outcome.runId, outcome.frames);
    }
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


