import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The Stack the current REQUEST named, for the duration of that request.
 *
 * ## Why the context is not a field on the runtime
 *
 * The tenant runtime is expensive and therefore cached once per user, then shared by
 * every conversation that user has (`main.ts:87,110-116`). A mutable
 * `runtime.stackId` would be correct for one turn at a time and racy for two: a
 * second turn started while the first is mid-flight would overwrite it, and the
 * first turn's tool calls would then read a Stack its user never named. A
 * cross-tenant read is not a bug anyone notices — it looks like an empty list, or
 * worse, a full one.
 *
 * `AsyncLocalStorage` keeps the value on the async chain instead: two concurrent
 * turns have two chains and cannot see each other's Stack, while a turn's BACKGROUND
 * work still inherits it. That inheritance is the load-bearing detail —
 * `turn-service.ts:88` launches `execute` synchronously inside `start()`, so the
 * whole turn, promises included, stays inside the store its request opened.
 *
 * ## What this is not
 *
 * Not authorisation. The value is a SELECTION of which Stack to read, forwarded by
 * this product's own page to this product's own server, and it is never persisted:
 * no conversation row, no schema, no default to fall back on. Without a context the
 * Stack-scoped tools fail closed rather than going out unscoped.
 *
 * The value is never logged: a Stack id is a tenant identifier, and this module
 * exists so the identifier travels without being written down anywhere.
 */
const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `stackId` as the request's Stack.
 *
 * An absent or blank value is not a Stack — `?stackId=` would otherwise name a Stack
 * called "" — so it runs `fn` with no context at all, and Stack-scoped tools refuse.
 */
export function withStackContext<T>(stackId: string | undefined, fn: () => T): T {
  const named = stackId?.trim();
  if (!named) return fn();
  return storage.run(named, fn);
}

/** The Stack the current request named, or `undefined` when it named none. */
export function currentStackId(): string | undefined {
  return storage.getStore();
}
