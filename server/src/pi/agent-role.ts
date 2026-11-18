import { readFileSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { composeSystemPrompt, parseAgentDefinition, type AgentDefinition } from "./agents.ts";
import { Logger } from "../log.ts";

/**
 * The shipped role as text on disk, re-read once per turn.
 *
 * ## Why it is not composed at boot
 *
 * It used to be: `main.ts` built `<base prompt> + # Role: …` once and handed the result to
 * every runtime. A role is documentation for the model, exactly as a skill is, and the
 * whole point of putting it in a volume is that an operator can correct a bad instruction
 * with a file edit. Composing at boot makes that edit take effect on the next RESTART, so
 * the fix is still an operational event — the same event the volume was meant to remove.
 *
 * The section therefore moved to the `before_agent_start` seam that already carries the
 * turn's Stack (`stack-prompt.ts`): the text is read on the turn's own async chain
 * (never captured in the per-user runtime, which is shared and long-lived), and lands in
 * the leading system message of that turn's request.
 *
 * ## What a role file CANNOT do
 *
 * It grants nothing. Tools, model and thinking level stay deployment concerns, and the
 * body is compared against what the session was actually provisioned with rather than
 * being trusted to say what it may use. A `.md` file that could widen its own permissions
 * would be a privilege-escalation surface that anyone with volume access could edit.
 *
 * ## Fail soft, on purpose
 *
 * Boot is strict (a selected definition that cannot be parsed or that carries keys this
 * runtime cannot honor fails the start — `main.ts`). A turn is not: an operator who
 * mistypes a file at 3am must lose the CORRECTION, not the agent. So a file that cannot
 * be read, or whose frontmatter is refused, falls back to the last valid text and logs a
 * warning; the turn runs.
 */

/**
 * Which definition a deployment selected, and the file it was read from.
 *
 * `name` is the SELECTION (`AGENT_DEFINITION`, a boot-time fact). `path` is what makes
 * the per-turn read possible, and both are part of the cache key: two deployments can
 * point at the same name in different directories, and two definitions can share a file
 * name across directories — a cache keyed on one of them alone would serve one role's
 * text for another's.
 */
export type AgentRoleSource = { name: string; path: string };

/** What one turn should do with the role, and what it should tell the person. */
export interface RoleResolution {
  /** The text to apply to this turn's prompt; `undefined` when there is no role to apply. */
  role: AgentDefinition | undefined;
  /** A sentence the turn's output can show. `undefined` when there is nothing to say. */
  notice: string | undefined;
}

/** One cached parse, plus the file state it was parsed from. */
interface CachedRole {
  mtimeMs: number;
  size: number;
  definition: AgentDefinition;
  namedTools: string[];
}

export interface AgentRoleReaderOptions {
  /** Where warnings go. `Logger` satisfies this; a test supplies a capturer. */
  log?: Pick<Logger, "warn">;
}

/**
 * Reads the selected role per turn, with a last-good cache.
 *
 * The cache is keyed by definition name + path and invalidated when the file's mtime or
 * size changes, which is the cheapest pair of facts that changes on a real edit. A file
 * that cannot be read at all keeps its previous entry, which is what makes
 * {@link resolve} able to return the last valid text instead of nothing.
 */
export class AgentRoleReader {
  private readonly log: Pick<Logger, "warn">;
  private readonly cached = new Map<string, CachedRole>();

  constructor(options: AgentRoleReaderOptions = {}) {
    this.log = options.log ?? defaultLog();
  }

  /**
   * The role for this turn, and the notice to show with it.
   *
   * `provisioned` is the tool names the session actually exposes
   * (`TenantRuntime.exposedToolNames`): the body is checked against what this deployment
   * granted, never against a list the file itself supplies.
   */
  resolve(source: AgentRoleSource | undefined, provisioned: readonly string[]): RoleResolution {
    if (!source) return { role: undefined, notice: undefined };

    const key = `${source.name}\u0000${source.path}`;
    const { entry, problem } = this.current(key, source);

    // A file that cannot be used is reported to the person, not only to the log. The turn
    // still runs: the role is TEXT, and losing the correction must never cost the turn.
    const missing = entry ? entry.namedTools.filter((name) => !provisioned.includes(name)) : [];
    if (missing.length > 0) {
      this.log.warn("agent role names tools this deployment does not provision", {
        role: entry!.definition.name,
        file: source.path,
        tools: missing,
      });
    }

    const notices = [
      problem,
      missing.length > 0 ? roleToolNotice(entry!.definition.name, missing) : undefined,
    ].filter((sentence): sentence is string => sentence !== undefined);

    return {
      role: entry?.definition,
      notice: notices.length > 0 ? notices.join(" ") : undefined,
    };
  }

  /**
   * The cache entry for one source, re-reading only when the file changed.
   *
   * Returns the previous entry when the file is unreadable, refused, or no longer declares
   * the selected name — plus the sentence that explains which of those happened. `entry`
   * is `undefined` only when there has never been a valid text, the first-turn case where
   * there is nothing to fall back to and the turn runs with no role section at all.
   */
  private current(
    key: string,
    source: AgentRoleSource,
  ): { entry: CachedRole | undefined; problem: string | undefined } {
    const previous = this.cached.get(key);

    let stats: { mtimeMs: number; size: number };
    try {
      stats = statSync(source.path);
    } catch (error) {
      return this.unusable(source, previous, {
        message: "agent role could not be read",
        what: "could not be read",
        error,
      });
    }

    if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
      return { entry: previous, problem: undefined };
    }

    let text: string;
    try {
      text = readFileSync(source.path, "utf8");
    } catch (error) {
      return this.unusable(source, previous, {
        message: "agent role could not be read",
        what: "could not be read",
        error,
      });
    }

    let parsed: ReturnType<typeof parseAgentDefinition>;
    try {
      parsed = parseAgentDefinition(text, source.path);
    } catch (error) {
      return this.unusable(source, previous, {
        message: "agent role file was refused",
        what: "was refused",
        error,
      });
    }

    const { definition, unsupportedKeys } = parsed;
    // Refused here for the same reason the boot refuses the selection (S7): honoring
    // half a definition would leave a file that looks applied and behaves differently.
    // At turn time the refusal is recoverable, so it is a warning plus the last text.
    if (unsupportedKeys.length > 0) {
      return this.unusable(source, previous, {
        message: "agent role file was refused",
        what: "was refused",
        error: new Error(
          `frontmatter carries ${unsupportedKeys.join(", ")}, which this runtime cannot honor`,
        ),
      });
    }
    // THE IDENTITY RULE. The applied definition is the one that DECLARES the selected
    // name: `AGENT_DEFINITION=<name>` is resolved against the frontmatter `name:`, never
    // against a file name (`loadAgentDefinitions` keys its map that way, which is what the
    // boot check reads). The per-turn read has to enforce the same rule, because the boot
    // check does not run again: editing that one line in the volume would otherwise apply
    // a role under a name this deployment never selected.
    if (definition.name !== source.name) {
      return this.unusable(source, previous, {
        message: "agent role file declares a different name than the selected definition",
        what: "declares a name this deployment did not select",
        error: new Error(
          `it now declares name "${definition.name}", and this deployment selected "${source.name}"`,
        ),
      });
    }

    const fresh: CachedRole = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      definition,
      namedTools: namedTools(definition.body),
    };
    this.cached.set(key, fresh);
    return { entry: fresh, problem: undefined };
  }

  /**
   * One report for a file that cannot be used: the log line, and the sentence the turn's
   * output carries.
   *
   * Both are built here so the operator's log and the person's screen cannot end up
   * describing different files. The sentence says what the turn actually did, because
   * "the role file is broken" without that leaves the reader guessing whether the agent
   * ran with a stale role or with none.
   *
   * `report.message` therefore says only WHAT happened to the file, never what the turn
   * did about it: there are two outcomes (`previous` exists, or it does not) and ONE
   * wording for both is false in the branch it does not describe. That was a real defect —
   * the log claimed "the turn keeps the last valid role text" on a first turn, where the
   * turn in fact ran with no role at all — so the outcome is appended here, from the same
   * expression the notice uses, and both branches are pinned by a test.
   */
  private unusable(
    source: AgentRoleSource,
    previous: CachedRole | undefined,
    report: { message: string; what: string; error: unknown },
  ): { entry: CachedRole | undefined; problem: string } {
    const used =
      previous === undefined
        ? "this turn ran without a role"
        : "this turn used the last valid role text";
    this.log.warn(`${report.message}; ${used}`, {
      file: source.path,
      role: source.name,
      error: describe(report.error),
      hadPrevious: previous !== undefined,
    });
    return {
      entry: previous,
      problem: `The agent role file ${source.path} ${report.what} (${describe(report.error)}); ${used}.`,
    };
  }
}

/**
 * The tools a role body tells the model to call.
 *
 * The rule is the one `test/provision-mcp.test.ts` already applies to the grant list: a
 * snake_case name in backticks is a tool, because that is how the body names them. A
 * false positive is reported to the person as "this deployment does not provision it",
 * which is annoying but honest; a false negative would ship a role asking for a tool it
 * does not have — the failure this check exists to make visible.
 */
export function namedTools(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/**
 * What a role naming an unprovisioned tool says to the person, in one factual sentence.
 *
 * Like the Stack notice (`resolveStackArgument`), the claim is about what THIS deployment
 * did: it provisioned a tool list, and the role names names that are not on it. The turn
 * still ran with the role applied, so the sentence says that too instead of implying a
 * refusal that did not happen.
 */
export function roleToolNotice(roleName: string, missing: readonly string[]): string {
  return (
    `Agent role "${roleName}" tells the model to call ${missing.join(", ")}, ` +
    "which this deployment has not provisioned. The turn ran anyway."
  );
}

/**
 * The role as a prompt section, byte-identical to what boot composition produced.
 *
 * It goes through `composeSystemPrompt` rather than formatting the three parts again: one
 * author for the section means the per-turn path cannot drift from the text
 * `README.md` documents (`# Role: <name>`, then the description, then the body).
 */
export function rolePromptSection(definition: AgentDefinition): string {
  return composeSystemPrompt("", definition).trim();
}

/**
 * The turn's role, on the turn's own async chain.
 *
 * The same reasoning as `stack-context.ts`: the runtime and its loader are built once per
 * user and shared by every conversation that user has, so a value captured there would be
 * the value of whichever turn built it first. `AsyncLocalStorage` keeps two concurrent
 * turns from seeing each other's role without threading an argument through the SDK.
 */
const roleStorage = new AsyncLocalStorage<AgentDefinition | undefined>();

/** Run one turn with `role` as the role its prompt will carry. */
export function withRoleContext<T>(role: AgentDefinition | undefined, run: () => T): T {
  return roleStorage.run(role, run);
}

/** The role of the turn currently running, if this process selected one. */
export function currentRole(): AgentDefinition | undefined {
  return roleStorage.getStore();
}

/**
 * The Pi extension that appends the turn's role to the prompt.
 *
 * Registered BEFORE `stackPromptExtension` on purpose: Pi runs `before_agent_start`
 * handlers in registration order and each one sees the prompt the previous one forced, so
 * the role renders first and the turn's Stack last. A reader of the request can then tell
 * the standing identity (`# Role: …`) from the turn's own fact (`<session_stack>`), and
 * the role never grows a Stack-shaped block in the middle of it.
 *
 * A turn with no role returns nothing at all: no section, no heading, no empty wrapper.
 * With `AGENT_DEFINITION` unset the prompt is exactly what it was before this feature.
 */
export const rolePromptExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    const role = currentRole();
    if (!role) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${rolePromptSection(role)}` };
  });
};

/** The reason a thrown value carries, in the wording the log and the notice will use. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let processLogger: Logger | undefined;

/** The logger used when the caller supplies none, built the same way `main.ts` builds it. */
function defaultLog(): Logger {
  processLogger ??= new Logger({ level: "info" });
  return processLogger;
}
