// Variable substitution for the API client (ARCHITECTURE.md §5.2). Pure and
// testable: no I/O here. `{{name}}` resolves against the supplied scopes
// (Postman precedence, lowest → highest: globals < collection < environment <
// data file row < request-local), and `{{$guid}}`-style DYNAMIC variables make
// a fresh value on every use.
//
// Secret references `${vault:path}` and `${env:NAME}` are intentionally NOT
// resolved here — they are expanded in the main process at send time
// (plugins/api-client/resolve.ts), so a secret value never has to pass through
// this pure layer or the UI.

export type VarScope = Record<string, string>;

const VAR_RE = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;

/** Merge scopes lowest→highest precedence into one lookup table. */
export function mergeScopes(...scopes: VarScope[]): VarScope {
  return Object.assign({}, ...scopes);
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const hex = (n: number) => Array.from({ length: n }, () => randInt(0, 15).toString(16)).join('');
function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
  }
}
const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Radia', 'Tim'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Perlman', 'Lee'];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

/** Postman's most used dynamic variables. Unknown `$names` stay verbatim. */
export const DYNAMIC_VARS: Record<string, () => string> = {
  $guid: uuid,
  $randomUUID: uuid,
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randInt(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => pick([...'abcdefghijklmnopqrstuvwxyz0123456789']),
  $randomHexadecimal: () => hex(1),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomUserName: () => `${pick(FIRST).toLowerCase()}${randInt(1, 999)}`,
  $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${randInt(1, 99)}@example.com`,
  $randomWord: () => pick(WORDS),
  $randomIP: () => [randInt(1, 254), randInt(0, 255), randInt(0, 255), randInt(1, 254)].join('.'),
  $randomColor: () => pick(['red', 'green', 'blue', 'orange', 'purple', 'teal']),
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
};

/** Replace every `{{name}}` in `input` using `vars` (+ dynamic `{{$…}}`). Unknown
 *  names are left verbatim so a missing variable is visible rather than silently blank. */
export function substituteVars(input: string, vars: VarScope): string {
  return input.replace(VAR_RE, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    const dyn = DYNAMIC_VARS[name];
    return dyn ? dyn() : whole;
  });
}

/** List the `{{name}}` references in a string (for UI highlighting / lint). */
export function referencedVars(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

/** `{{names}}` still unresolved after substitution (shown as a warning). */
export function unresolvedVars(input: string): string[] {
  return referencedVars(input).filter((n) => !n.startsWith('$') || !DYNAMIC_VARS[n]);
}

/** True if a resolved string still carries a secret reference to expand in main. */
export function hasSecretRef(input: string): boolean {
  return /\$\{(vault|env):[^}]+\}/.test(input);
}

/** Enabled rows → a lookup table (later rows win). */
export function scopeOf(rows: { key: string; value: string; on: boolean }[] | undefined): VarScope {
  const out: VarScope = {};
  for (const r of rows ?? []) if (r.on && r.key) out[r.key] = r.value;
  return out;
}
