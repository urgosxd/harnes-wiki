/**
 * @file src/lib/stacks.ts
 * @description Turns a `list_stacks` tool result into a picker list.
 *
 * ## Why the list comes from the agent and not from this client
 *
 * The stacks live in the external service, and this server does not hold their
 * registry. Reading them directly would mean a second MCP connection opened for a
 * single dropdown, with its own credentials and its own failure modes. Asking the
 * session that already exists is both simpler and the same data path the agent
 * uses — so what the picker shows is exactly what the agent can act on.
 *
 * ## What this module refuses to do
 *
 *  - It never invents a stack. A malformed payload yields an empty list and a
 *    reason, never a fabricated entry: a picker offering a stack that does not
 *    exist produces calls the service rejects.
 *  - It never treats a failure as emptiness. The service answers `isError` for an
 *    id that does not exist precisely so the two cannot be confused, and the same
 *    rule applies here.
 */

/** One reachable stack, as the service describes it. */
export interface StackOption {
  id: string;
  name: string;
  /** The stack this endpoint is bound to, when the service says so. */
  isCurrent: boolean;
}

export interface ParsedStacks {
  stacks: StackOption[];
  /** Set when the payload could not be read. Never set merely because it was empty. */
  problem: string | null;
}

/**
 * Read a `list_stacks` result.
 *
 * The tool returns `{ stacks: [...], count }` as JSON inside a text block, so the
 * parsing is deliberately tolerant about the wrapper and strict about the entries:
 * an entry without a usable `id` is dropped rather than defaulted, because an empty
 * id would be sent back to the service as a real one.
 */
export function parseStacksPayload(text: string): ParsedStacks {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { stacks: [], problem: "The stack list could not be read." };
  }

  // The value may be the object itself or a wrapper carrying it.
  const container = payload as { stacks?: unknown } | undefined;
  const raw = container?.stacks;
  if (!Array.isArray(raw)) {
    return { stacks: [], problem: "The stack list could not be read." };
  }

  const stacks: StackOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { id?: unknown; name?: unknown; isCurrent?: unknown };
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") continue;
    stacks.push({
      id: candidate.id,
      // A stack with no name is still selectable; falling back to the id keeps it
      // identifiable without inventing a label.
      name: typeof candidate.name === "string" && candidate.name.trim() !== "" ? candidate.name : candidate.id,
      isCurrent: candidate.isCurrent === true,
    });
  }

  return { stacks, problem: null };
}

/**
 * Which stack a picker should select initially.
 *
 * `isCurrent` wins, because the service marks the stack its endpoint is bound to and
 * that is the one whose jobs a user is most likely asking about. Otherwise nothing is
 * selected: pre-selecting the first entry would silently pick a stack the user never
 * chose.
 */
export function defaultStackId(stacks: readonly StackOption[]): string | null {
  return stacks.find((stack) => stack.isCurrent)?.id ?? null;
}

/**
 * Whether a job started now would land in the Stack the picker shows.
 *
 * It would NOT, on the service as it stands: the write path binds its Stack once at
 * startup from the host's own environment, and there is no parameter on it a caller
 * can influence. Reads are Stack-scoped, writes are not. So a picker that offered
 * upload into any Stack would be showing the user a choice that changes nothing.
 *
 * Three cases, and the middle one is the only happy path:
 *
 *  - Nothing selected: nothing is named, so the host uses its own Stack, which is
 *    the same Stack the picker would default to. Allowed.
 *  - The selected Stack is the one the service marks `isCurrent`: that IS the bound
 *    Stack, so the choice and the destination agree. Allowed.
 *  - Anything else, including "several Stacks but none marked current": the
 *    destination cannot be made to match the selection, so it is refused with a
 *    reason instead of silently creating the job somewhere else.
 */
export type CreateTargetCheck = { ok: true } | { ok: false; reason: string };

export function checkCreateTarget(
  stacks: readonly StackOption[],
  selectedStackId: string | null,
): CreateTargetCheck {
  if (selectedStackId === null) return { ok: true };

  const bound = stacks.find((stack) => stack.isCurrent);
  if (bound?.id === selectedStackId) return { ok: true };

  const selectedName = stacks.find((stack) => stack.id === selectedStackId)?.name;
  const named = selectedName ? `"${selectedName}"` : "the selected Stack";

  if (!bound) {
    return {
      ok: false,
      reason:
        `The ingest service did not say which Stack it is bound to, so new jobs ` +
        `cannot be verified to land in ${named}. Select the Stack it reports as ` +
        `bound, or none.`,
    };
  }

  return {
    ok: false,
    reason:
      `New jobs go to "${bound.name}", the Stack this endpoint is bound to — not ` +
      `to ${named}. The service scopes READS by Stack but binds WRITES to its own, ` +
      `so switch to "${bound.name}" to start an ingest there.`,
  };
}
