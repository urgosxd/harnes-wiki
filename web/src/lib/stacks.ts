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
 * Whether a job started now can land where the picker says it will.
 *
 * ## What this replaced
 *
 * The previous version refused every Stack except the one the service marked
 * `isCurrent`, because writes were bound to the host's Stack while reads were
 * Stack-scoped. That asymmetry was real and the refusal was honest: offering a
 * choice the service would ignore is worse than refusing.
 *
 * It is gone upstream. `POST /api/ingest` now records the job in the Stack the
 * request names — verified by the acceptance pair, `200` with the requested Stack
 * and `404` with the bound one, for the same job id, via both the query and the
 * body. So the only question left is whether the selection is a Stack this endpoint
 * actually knows about.
 *
 * ## Why the check is not deleted outright
 *
 * A name the service does not recognise would surface as an opaque upstream error on
 * submit. Naming it before the call keeps the failure where the user can act on it.
 * And an empty list means the service admitted nothing, so there is nothing to verify
 * against — refusing there is honest rather than permissive.
 */
export type CreateTargetCheck = { ok: true } | { ok: false; reason: string };

export function checkCreateTarget(
  stacks: readonly StackOption[],
  selectedStackId: string | null,
): CreateTargetCheck {
  // Nothing selected: the endpoint uses its own Stack, which is what omitting the
  // parameter has always meant and still means.
  if (selectedStackId === null) return { ok: true };

  // No list yet: the picker has not received the agent's `list_stacks`, so no
  // selection can be verified against anything. A selection in this state is a value
  // nobody vouched for, and sending it would be a guess.
  if (stacks.length === 0) {
    return {
      ok: false,
      reason:
        "The Stack list has not loaded yet, so this selection cannot be verified. " +
        "Ask the assistant to list the Stacks, or clear the selection to use the " +
        "endpoint's own.",
    };
  }

  const known = stacks.some((stack) => stack.id === selectedStackId);
  if (known) return { ok: true };

  return {
    ok: false,
    reason:
      `"${selectedStackId}" is not a Stack this endpoint reported. Pick one from the ` +
      `list, or clear the selection to use the endpoint's own.`,
  };
}
