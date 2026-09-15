// ---------------------------------------------------------------------------
// Permission rulesets — wildcard rules evaluated last-match-wins (`findLast`),
// defaulting to `ask` when nothing matches. A ruleset is an ordered list of
// `{ tool, permission }`; the LAST matching rule decides.
// ---------------------------------------------------------------------------

export type Permission = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** Tool name or wildcard pattern (`*`, `bash*`, `read`). */
  tool: string;
  permission: Permission;
}

export type Ruleset = readonly PermissionRule[];

/** Convert a glob-ish pattern to a case-sensitive RegExp (`*` and `?` only). */
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matches(pattern: string, toolName: string): boolean {
  return patternToRegExp(pattern).test(toolName);
}

/**
 * Evaluate a tool invocation against a ruleset. Uses `findLast` so later rules
 * override earlier ones; the default when nothing matches is `ask`.
 */
export function evaluate(toolName: string, _input: unknown, ruleset: Ruleset): Permission {
  const rule = [...ruleset].reverse().find((r) => matches(r.tool, toolName));
  return rule?.permission ?? "ask";
}

/** Full access: every tool is allowed. */
export const allowAll: Ruleset = [{ tool: "*", permission: "allow" }];

/** Read-only: inspection tools allowed, everything else denied. */
export const readOnly: Ruleset = [
  { tool: "*", permission: "deny" },
  { tool: "read", permission: "allow" },
  { tool: "grep", permission: "allow" },
  { tool: "glob", permission: "allow" },
  { tool: "ls", permission: "allow" },
];
