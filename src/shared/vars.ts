// Variable substitution for the API client (ARCHITECTURE.md §5.2). Pure and
// testable: no I/O here. `{{name}}` resolves against the supplied scopes
// (request vars win over the active environment, which wins over globals).
//
// Secret references `${vault:path}` and `${env:NAME}` are intentionally NOT
// resolved here — they are expanded in the main process at send time (vault.ts),
// so a secret value never has to pass through this pure layer or the UI.

export type VarScope = Record<string, string>;

const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Merge scopes lowest→highest precedence into one lookup table. */
export function mergeScopes(...scopes: VarScope[]): VarScope {
  return Object.assign({}, ...scopes);
}

/** Replace every `{{name}}` in `input` using `vars`. Unknown names are left
 *  verbatim so a missing variable is visible rather than silently blank. */
export function substituteVars(input: string, vars: VarScope): string {
  return input.replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/** List the `{{name}}` references in a string (for UI highlighting / lint). */
export function referencedVars(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

/** True if a resolved string still carries a secret reference to expand in main. */
export function hasSecretRef(input: string): boolean {
  return /\$\{(vault|env):[^}]+\}/.test(input);
}
