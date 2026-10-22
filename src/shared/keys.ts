// Keyboard-accelerator helpers shared by the main process (matching key
// presses) and the Settings page (recording + displaying bindings).
//
// Bindings are stored as Electron accelerator strings ("CommandOrControl+Shift+H")
// so global ones can go straight to globalShortcut. For matching we reduce both
// sides to a canonical form built from the PHYSICAL key (KeyboardEvent.code), so
// Shift+` matches even though the produced character is "~".

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** Physical key code (KeyboardEvent.code) → accelerator key name, or null for modifiers/unknown. */
export function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

export interface KeyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Build an accelerator from a key press. Ctrl (Win) / Cmd (Mac) becomes CommandOrControl. */
export function toAccelerator(mods: KeyMods, key: string, isMac: boolean): string {
  const parts: string[] = [];
  if (isMac ? mods.meta : mods.ctrl) parts.push('CommandOrControl');
  if (isMac && mods.ctrl) parts.push('Control');
  if (!isMac && mods.meta) parts.push('Super');
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const KEY_ALIASES: Record<string, string> = { return: 'enter', escape: 'esc' };

/** Order-insensitive, platform-resolved form used to compare two bindings. */
export function canonical(accel: string, isMac: boolean): string | null {
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = '';
  for (const raw of accel.split('+')) {
    const p = raw.trim().toLowerCase();
    switch (p) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        if (isMac) meta = true;
        else ctrl = true;
        break;
      case 'control':
      case 'ctrl':
        ctrl = true;
        break;
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        meta = true;
        break;
      case 'alt':
      case 'option':
        alt = true;
        break;
      case 'shift':
        shift = true;
        break;
      default:
        key = KEY_ALIASES[p] ?? p;
    }
  }
  if (!key) return null;
  return [ctrl && 'ctrl', alt && 'alt', shift && 'shift', meta && 'meta', key].filter(Boolean).join('+');
}

/** Canonical form of a live key press (Electron Input or a DOM KeyboardEvent). */
export function pressCanonical(code: string, mods: KeyMods, isMac: boolean): string | null {
  const key = codeToKey(code);
  return key ? canonical(toAccelerator(mods, key, isMac), isMac) : null;
}

/**
 * A binding must use Ctrl/Cmd/Alt (Shift alone doesn't count) — otherwise it
 * would fire while typing. Function keys are the exception.
 */
export function isValidBinding(accel: string, isMac: boolean): boolean {
  const c = canonical(accel, isMac);
  if (!c) return false;
  const parts = c.split('+');
  const key = parts[parts.length - 1];
  if (/^f\d+$/.test(key)) return true;
  return parts.some((p) => p === 'ctrl' || p === 'alt' || p === 'meta');
}

const KEY_LABELS: Record<string, string> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  numadd: 'Num+',
  numsub: 'Num−',
  nummult: 'Num*',
  numdiv: 'Num/',
  numdec: 'Num.',
};

/** Human label: "Ctrl+Shift+H" on Windows, "⌘⇧H" on macOS. */
export function formatAccel(accel: string, isMac: boolean): string {
  const out = accel.split('+').map((raw) => {
    const t = raw.trim();
    switch (t.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        return isMac ? '⌘' : 'Ctrl';
      case 'control':
      case 'ctrl':
        return isMac ? '⌃' : 'Ctrl';
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        return isMac ? '⌘' : 'Win';
      case 'alt':
      case 'option':
        return isMac ? '⌥' : 'Alt';
      case 'shift':
        return isMac ? '⇧' : 'Shift';
    }
    if (/^num\d$/.test(t)) return 'Num' + t.slice(3);
    return KEY_LABELS[t] ?? t;
  });
  return out.join(isMac ? '' : '+');
}
