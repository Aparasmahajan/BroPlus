// cURL → request (Postman's "Import → Raw text" / paste-a-curl-into-the-URL-bar).
// Pure: used by the API panel (paste) and by the main-side importer.
import { newRequest, type KeyVal, type SavedRequest } from './api-model';

/** Split a shell command line into words (handles '…', "…", \-escapes and line continuations). */
export function shellWords(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' '); // bash \ and cmd ^ continuations
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '$' && s[i + 1] === "'") {
      // $'…' ANSI-C quoting (Chrome's "Copy as cURL (bash)" uses it).
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          cur += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
        } else cur += s[i];
        i++;
      }
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

/** Parse a curl command into a request (null if it isn't one). */
export function parseCurl(cmd: string): SavedRequest | null {
  const w = shellWords(cmd.trim());
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) return null;
  const req = newRequest('Imported from cURL');
  let method = '';
  let url = '';
  const data: string[] = [];
  const form: KeyVal[] = [];
  let get = false;
  let json = false;

  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const c = h.indexOf(':');
      if (c > 0) req.headers.push({ key: h.slice(0, c).trim(), value: h.slice(c + 1).trim(), on: true });
    } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-ascii') data.push(next());
    else if (a === '--data-urlencode') {
      const v = next();
      const eq = v.indexOf('=');
      data.push(eq >= 0 ? `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}` : encodeURIComponent(v));
    } else if (a === '--json') {
      data.push(next());
      json = true;
    } else if (a === '-F' || a === '--form' || a === '--form-string') {
      const v = next();
      const eq = v.indexOf('=');
      const key = eq >= 0 ? v.slice(0, eq) : v;
      const val = eq >= 0 ? v.slice(eq + 1) : '';
      const isFile = a !== '--form-string' && val.startsWith('@');
      form.push({ key, value: isFile ? val.slice(1).split(';')[0] : val, on: true, type: isFile ? 'file' : 'text' });
    } else if (a === '-u' || a === '--user') {
      const v = next();
      const c = v.indexOf(':');
      req.auth = { kind: 'basic', username: c >= 0 ? v.slice(0, c) : v, password: c >= 0 ? v.slice(c + 1) : '' };
    } else if (a === '-A' || a === '--user-agent') req.headers.push({ key: 'User-Agent', value: next(), on: true });
    else if (a === '-e' || a === '--referer') req.headers.push({ key: 'Referer', value: next(), on: true });
    else if (a === '-b' || a === '--cookie') req.headers.push({ key: 'Cookie', value: next(), on: true });
    else if (a === '-G' || a === '--get') get = true;
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (a === '-k' || a === '--insecure') req.settings = { ...req.settings, verifyTls: false };
    else if (a === '-L' || a === '--location') req.settings = { ...req.settings, followRedirects: true };
    else if (a === '--url') url = next();
    else if (a === '--compressed' || a === '-s' || a === '--silent' || a === '-v' || a === '-i' || a === '--include') continue;
    else if (/^-(o|--output|m|--max-time|--connect-timeout|w|--write-out|x|--proxy|--retry)$/.test(a)) next();
    else if (!a.startsWith('-') && !url) url = a;
  }

  if (get && data.length) {
    url += (url.includes('?') ? '&' : '?') + data.join('&');
    data.length = 0;
  }
  // Query params into rows (Postman does this so they are editable).
  const qi = url.indexOf('?');
  if (qi >= 0) {
    for (const part of url.slice(qi + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      req.params.push({ key: dec(eq >= 0 ? part.slice(0, eq) : part), value: dec(eq >= 0 ? part.slice(eq + 1) : ''), on: true });
    }
    url = url.slice(0, qi);
  }
  req.url = url;

  const ct = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (form.length) {
    req.bodyMode = 'multipart';
    req.multipart = form;
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  } else if (data.length) {
    const body = data.join('&');
    if (json || ct.includes('json') || /^\s*[[{]/.test(body)) {
      req.bodyMode = 'json';
      req.body = body;
    } else if (ct.includes('xml')) {
      req.bodyMode = 'xml';
      req.body = body;
    } else if (!ct || ct.includes('x-www-form-urlencoded')) {
      req.bodyMode = 'form';
      req.form = body.split('&').filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        const dec = (s: string) => {
          try {
            return decodeURIComponent(s.replace(/\+/g, ' '));
          } catch {
            return s;
          }
        };
        return { key: dec(eq >= 0 ? p.slice(0, eq) : p), value: dec(eq >= 0 ? p.slice(eq + 1) : ''), on: true };
      });
    } else {
      req.bodyMode = 'text';
      req.body = body;
    }
  }
  if (json && !ct) req.headers.push({ key: 'Content-Type', value: 'application/json', on: true });
  req.method = method || (data.length || form.length ? 'POST' : 'GET');
  try {
    req.name = `${req.method} ${new URL(url).pathname}`;
  } catch {
    /* keep the default name */
  }
  return req;
}
