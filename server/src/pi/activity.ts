/**
 * Turning internal names into something a user can read.
 *
 * The interface shows that the assistant is working without exposing Pi's
 * internals: no tool ids, no file paths, no "pi" jargon. A tool name like
 * `mcp__crm__get_order` becomes "looking up an order", and a skill load becomes
 * "reading the support guide".
 */

/** Human labels for the tools this product can mount. */
const TOOL_LABELS: Record<string, string> = {
  read: "Reading a document",
  grep: "Searching the workspace",
  find: "Looking through files",
  ls: "Checking the workspace",
  bash: "Running a command",
  write: "Writing a file",
  edit: "Updating a file",
  get_order: "Looking up an order",
};

/**
 * Label for one tool call.
 *
 * MCP tools arrive as `mcp__<server>__<tool>`; the server part is shown as the
 * data source because it is the one piece a user can relate to ("crm"), while the
 * tool part stays generic.
 */
export function toolLabel(toolName: string): string {
  const exact = TOOL_LABELS[toolName];
  if (exact) return exact;

  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (mcp) {
    const server = humanize(mcp[1] ?? "");
    const tool = humanize(mcp[2] ?? "");
    return tool ? `${tool} via ${server}` : `Using ${server}`;
  }

  // Unknown tools get a neutral phrase instead of their identifier: a stray tool
  // name is implementation detail, not product copy.
  return "Using a tool";
}

/** "order_lookup" -> "order lookup" */
export function humanize(identifier: string): string {
  return identifier.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Skill names mentioned in a chunk of assistant output.
 *
 * Pi can inline a skill's content into the model's output between markers. The
 * exact block format is the SDK's business, so this looks only for the skill tag
 * and returns the names it finds; if the format changes, no names are reported and
 * the client falls back to the generic activity indicator. It never throws.
 */
export function skillsInOutput(text: string): string[] {
  const names = new Set<string>();
  // A skill block names its skill; accept the common attribute spellings.
  const pattern = /<skill[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}
