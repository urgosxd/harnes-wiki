import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { currentStackId } from "./stack-context.ts";

/**
 * Put the turn's Stack where the MODEL can read it, not only where a tool can.
 *
 * ## Why the prompt and not a message
 *
 * Until now the only surface holding the Stack was the per-call `stackId` argument the
 * tool proxy injects (`resolveStackArgument` in `tenant-runtime.ts`). That is enough for
 * a call, and useless for a sentence: asked "ingest this into my stack", the model had
 * no way to know which Stack the page was showing, so it either asked or picked one out
 * of `list_stacks`. The value has to reach the model BEFORE it decides to call anything,
 * which is the system prompt of the turn.
 *
 * The user's own text is never touched. This text is not appended to the transcript and
 * is not shown in the chat: it is a forced prompt, which Pi projects as the leading
 * system message of one provider request (`before_agent_start` result `systemPrompt`).
 *
 * ## Why it is read per turn
 *
 * The runtime and its loader are built once per user and shared by every conversation
 * that user has (`main.ts`), so nothing here may be captured at build time: the factory
 * closes over the ASYNC CHAIN, not over a value. `currentStackId()` is called inside the
 * handler, on the turn's own chain, so two concurrent turns with two Stacks cannot see
 * each other's — the same reasoning that keeps the context out of the runtime in
 * `stack-context.ts`.
 *
 * ## What it is not
 *
 * Not a second resolution order. This section states the session's Stack as the DEFAULT;
 * an explicit `stackId` argument still wins and a divergence is still reported
 * (`resolveStackArgument`, unchanged). And not authorisation: the value is a selection
 * the caller already made in the link (S11 of `multitenant-stackId.md`).
 * ## Why the section is tagged
 *
 * Pi wraps every named prompt section in a tag of the same name (`buildSystemPromptSections`
 * in the SDK: `<${name}>\n${content}\n</${name}>`), so the model can tell where a block
 * starts and ends. This one is appended as bare text to an already-rendered prompt, which
 * makes the tag the only thing that stops it from reading as a continuation of whatever
 * section came last.
 */
export function stackPromptSection(stackId: string): string {
  return [
    "<session_stack>",
    `The session's Stack is ${stackId}.`,
    `When the user says "my stack", "this stack" or "the stack", they mean ${stackId}.`,
    "Stack-scoped tools take a stackId argument, and omitting it applies the session's Stack.",
    "Do not call list_stacks, and do not act on a different Stack, unless the user asks for another one.",
    "</session_stack>",
  ].join("\n");
}

/**
 * The Pi extension that adds {@link stackPromptSection} to the turn's prompt.
 *
 * A turn whose link names no Stack returns nothing at all, so no section is added: the
 * fail-closed tool error stays the only statement about the missing Stack (S4), and the
 * chat still opens without one.
 */
export const stackPromptExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    const stackId = currentStackId();
    if (!stackId) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${stackPromptSection(stackId)}` };
  });
};
