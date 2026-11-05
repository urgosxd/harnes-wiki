/**
 * Agent definitions: the product's own role files.
 *
 * Pi 1.4.0 core has no agent-definition discovery. `DefaultResourceLoader` is built
 * with `noExtensions: true` and there is no delegate/subagent tool, so nothing in the
 * runtime would ever read a file like this. This module is therefore the loader: it
 * parses the frontmatter and the server composes the result into the system prompt it
 * hands to the runtime.
 *
 * Lenient parse, strict selection. A host pi-herdsman definition carries `tools`,
 * `model` and `thinking`, and this runtime can honor none of them. Failing the file
 * for that would reject an entire mounted pi-herdsman directory — including every
 * definition the operator actually wants — and stop the boot even with nothing
 * selected. So the parse succeeds and reports the keys, and the server refuses only
 * the definition it was asked to apply: there, ignoring a key would leave a copied
 * file looking honored while the agent behaved differently.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A role document: what the agent is, in the operator's words. */
export type AgentDefinition = { name: string; description: string; body: string };

/** One parsed document plus the keys it carried that this runtime cannot honor. */
export type ParsedAgentDefinition = {
  definition: AgentDefinition;
  unsupportedKeys: string[];
};

/** A directory's definitions, plus which files carried reportable keys. */
export type LoadedAgentDefinitions = {
  definitions: Map<string, AgentDefinition>;
  unsupported: Array<{ file: string; keys: string[] }>;
};

const SUPPORTED_KEYS = ["name", "description"];
const DELIMITER = "---";
/** Notes, never a definition: documenting the directory must not load as an agent. */
const README = "README.md";

/**
 * Definition name to its unsupported keys, keyed by the `definitions` map it belongs
 * to. A side table keeps the public shape of a loaded directory exactly as described
 * above while still answering by name — the alternative, re-deriving the name from a
 * file path, would be a second parse of data already in hand.
 */
const unsupportedByName = new WeakMap<Map<string, AgentDefinition>, Map<string, string[]>>();

function required(fields: Map<string, string>, key: string, file: string): string {
  const value = fields.get(key);
  if (!value) throw new Error(`${file}: missing required frontmatter key "${key}"`);
  return value;
}

/**
 * Parse one definition document.
 *
 * `file` is only used for error messages: nothing here reads from disk, so the caller
 * decides where the text came from and the message can name it exactly.
 */
export function parseAgentDefinition(source: string, file: string): ParsedAgentDefinition {
  const lines = source.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== DELIMITER) {
    throw new Error(`${file}: missing frontmatter: the first line must be "---"`);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (end === -1) {
    throw new Error(`${file}: missing frontmatter: no closing "---" line`);
  }

  // No YAML library is available (the dependency list is fixed), so the frontmatter
  // is read as `key: value` lines. That is a smaller contract than YAML, and it is
  // enforced rather than guessed: a line that is not `key: value` is an error.
  const fields = new Map<string, string>();
  const unsupportedKeys: string[] = [];
  for (const [offset, raw] of lines.slice(1, end).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`${file}: frontmatter line ${offset + 2} is not "key: value": "${line}"`);
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!SUPPORTED_KEYS.includes(key)) {
      // Reported, not thrown: only the selected definition has to be free of these.
      // A repeated key is named once.
      if (!unsupportedKeys.includes(key)) unsupportedKeys.push(key);
      continue;
    }
    fields.set(key, value);
  }

  const name = required(fields, "name", file);
  const description = required(fields, "description", file);

  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  if (body === "") {
    throw new Error(`${file}: empty body: a definition must say what the agent does`);
  }

  return { definition: { name, description, body }, unsupportedKeys };
}

/**
 * Load every definition in `dir`, keyed by its declared `name`.
 *
 * A missing directory returns an empty map rather than failing: the mount is
 * optional, and a deployment that carries no definitions is a valid one. Reading in
 * filename order keeps which file wins deterministic — and there is no "wins": two
 * files declaring the same name are an error naming both.
 *
 * A file carrying keys this runtime cannot honor is loaded anyway and listed in
 * `unsupported`, so the server warns about each one instead of refusing the boot.
 */
export function loadAgentDefinitions(dir: string): LoadedAgentDefinitions {
  const definitions = new Map<string, AgentDefinition>();
  const unsupported: Array<{ file: string; keys: string[] }> = [];
  const byName = new Map<string, string[]>();

  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== README)
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { definitions, unsupported };
    throw error;
  }

  const origins = new Map<string, string>();
  for (const name of names) {
    const file = join(dir, name);
    const parsed = parseAgentDefinition(readFileSync(file, "utf8"), file);
    const previous = origins.get(parsed.definition.name);
    if (previous !== undefined) {
      throw new Error(`${previous} and ${file} both define agent "${parsed.definition.name}"`);
    }
    origins.set(parsed.definition.name, file);
    definitions.set(parsed.definition.name, parsed.definition);
    if (parsed.unsupportedKeys.length > 0) {
      unsupported.push({ file, keys: parsed.unsupportedKeys });
      byName.set(parsed.definition.name, parsed.unsupportedKeys);
    }
  }

  unsupportedByName.set(definitions, byName);
  return { definitions, unsupported };
}

/**
 * The keys this runtime cannot honor on the definition called `name`.
 *
 * Empty for a definition that carries none and for a name that was never loaded:
 * reporting a missing definition is the selection's job, not this helper's.
 */
export function unsupportedKeysFor(loaded: LoadedAgentDefinitions, name: string): string[] {
  if (!loaded.definitions.has(name)) return [];
  return unsupportedByName.get(loaded.definitions)?.get(name) ?? [];
}

/**
 * Build the prompt for a selected definition.
 *
 * The base prompt stays first and unmodified: it carries the behavior the product
 * always guarantees, and a role document is an addition to it, not a replacement.
 */
export function composeSystemPrompt(base: string, def: AgentDefinition): string {
  return `${base}\n\n# Role: ${def.name}\n\n${def.description}\n\n${def.body.trim()}`;
}
