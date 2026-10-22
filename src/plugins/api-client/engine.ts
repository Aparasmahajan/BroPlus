// HttpEngine — the API client / runner sender (ARCHITECTURE.md §5.1).
//
// Runs in MAIN (Node), so it can send any method with any headers to any origin
// with no CORS — that is what makes it Postman-class, not a web page. undici is
// Node's own HTTP client and keeps header order + duplicates (headers go over
// the wire as a flat list, never collapsed into an object).
//
// Per send: timeout, redirect policy (followed here, hop by hop, so cookies and
// the redirect chain are visible), TLS verification on/off, the BROWSER's cookie
// jar (the shared-session thesis: a site you are signed into in a tab is signed
// in here too), and optionally the Proxy plugin as upstream so the send shows in
// its HTTP history.
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { STATUS_CODES } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Session } from 'electron';
import type { HttpExchange, HttpRequest, Header } from '../../shared/http-model';
import type { ProxyService } from '../../shared/services';

/** Hard ceiling so a huge response can't OOM the UI (ARCHITECTURE.md §5.1). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface SendOptions {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  /** Cookie jar to read from / write Set-Cookie into (null = no cookies). */
  cookies: Session | null;
  /** Upstream proxy (the Proxy plugin) — undefined = direct. */
  proxy?: ProxyService;
}

export interface SendResult {
  exchange: HttpExchange;
  redirects: { status: number; url: string }[];
}

export class HttpEngine {
  private direct = new Map<boolean, Agent>();
  private proxied = new Map<string, ProxyAgent>();

  async send(req: HttpRequest, opts: SendOptions): Promise<SendResult> {
    const started = Date.now();
    const dispatcher = await this.dispatcher(opts);
    const redirects: { status: number; url: string }[] = [];

    let hop: HttpRequest = { ...req, headers: [...req.headers] };
    for (;;) {
      const sent = opts.cookies ? await withCookies(hop, opts.cookies) : hop;
      const t0 = Date.now();
      const res = await request(sent.url, {
        method: sent.method as Dispatcher.HttpMethod,
        headers: sent.headers.flat(),
        body: bodyOf(sent),
        dispatcher,
        signal: AbortSignal.timeout(Math.max(1, opts.timeoutMs)),
      });
      const ttfb = Date.now() - t0;
      const headers = headerList(res.headers);
      if (opts.cookies) await storeCookies(opts.cookies, sent.url, headers);

      const location = headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
      const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304 && !!location;
      if (isRedirect && opts.followRedirects && redirects.length < opts.maxRedirects) {
        await res.body.dump().catch(() => {});
        const next = new URL(location!, sent.url).toString();
        redirects.push({ status: res.statusCode, url: next });
        hop = redirectRequest(hop, res.statusCode, next);
        continue;
      }

      const { buf, truncated } = await readCapped(res.body);
      const u = new URL(sent.url);
      return {
        redirects,
        exchange: {
          id: randomUUID(),
          origin: 'api',
          request: sent,
          response: {
            status: res.statusCode,
            statusText: STATUS_CODES[res.statusCode] ?? '',
            headers,
            body: { b64: buf.toString('base64'), truncatedBytes: truncated || undefined },
            timingMs: Date.now() - started,
            ttfbMs: ttfb,
          },
          meta: {
            startedAt: started,
            host: u.host,
            scheme: u.protocol === 'https:' ? 'https' : 'http',
            notes: redirects.length ? `${redirects.length} redirect(s) followed` : undefined,
          },
        },
      };
    }
  }

  private async dispatcher(opts: SendOptions): Promise<Dispatcher> {
    if (opts.proxy?.running) {
      // The proxy MITMs TLS with its own CA: trust exactly that CA for this send.
      const key = `${opts.proxy.port}|${opts.verifyTls}`;
      let p = this.proxied.get(key);
      if (!p) {
        const ca = await opts.proxy.caPem().catch(() => undefined);
        p = new ProxyAgent({
          uri: `http://127.0.0.1:${opts.proxy.port}`,
          requestTls: { rejectUnauthorized: opts.verifyTls, ca },
        });
        this.proxied.set(key, p);
      }
      return p;
    }
    let a = this.direct.get(opts.verifyTls);
    if (!a) {
      a = new Agent({ connect: { rejectUnauthorized: opts.verifyTls } });
      this.direct.set(opts.verifyTls, a);
    }
    return a;
  }
}

// --- helpers ------------------------------------------------------------------

function bodyOf(req: HttpRequest): string | Buffer | undefined {
  if (!req.body) return undefined;
  if (req.body.b64 != null) return Buffer.from(req.body.b64, 'base64');
  return req.body.text;
}

function headerList(h: Record<string, string | string[] | undefined>): Header[] {
  const out: Header[] = [];
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const vv of v) out.push([k, vv]);
    else if (v != null) out.push([k, String(v)]);
  }
  return out;
}

async function readCapped(body: AsyncIterable<unknown>): Promise<{ buf: Buffer; truncated: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = 0;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    if (total < MAX_BODY_BYTES) {
      const room = MAX_BODY_BYTES - total;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      if (buf.length > room) truncated += buf.length - room;
    } else {
      truncated += buf.length;
    }
    total += buf.length;
  }
  return { buf: Buffer.concat(chunks), truncated };
}

/** RFC 9110: 303 (and 301/302 for POST, as browsers do) becomes a body-less GET; 307/308 resend as-is. */
function redirectRequest(prev: HttpRequest, status: number, url: string): HttpRequest {
  const sameOrigin = new URL(prev.url).origin === new URL(url).origin;
  const toGet = status === 303 || ((status === 301 || status === 302) && prev.method !== 'GET' && prev.method !== 'HEAD');
  let headers = prev.headers.filter(([k]) => k.toLowerCase() !== 'host' && k.toLowerCase() !== 'cookie');
  // Never leak credentials to another origin on a redirect.
  if (!sameOrigin) headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
  if (toGet) {
    headers = headers.filter(([k]) => !/^content-(type|length|encoding)$/i.test(k));
    return { method: 'GET', url, headers };
  }
  return { ...prev, url, headers };
}

/** Add the browser jar's cookies for this URL (merged after any Cookie header the user set). */
async function withCookies(req: HttpRequest, jar: Session): Promise<HttpRequest> {
  let list: Electron.Cookie[] = [];
  try {
    list = await jar.cookies.get({ url: req.url });
  } catch {
    return req;
  }
  if (!list.length) return req;
  const jarPart = list.map((c) => `${c.name}=${c.value}`).join('; ');
  const i = req.headers.findIndex(([k]) => k.toLowerCase() === 'cookie');
  const headers = [...req.headers];
  if (i >= 0) {
    const own = headers[i][1];
    const ownNames = new Set(own.split(';').map((p) => p.split('=')[0].trim()));
    const extra = list.filter((c) => !ownNames.has(c.name)).map((c) => `${c.name}=${c.value}`);
    headers[i] = [headers[i][0], [own, ...extra].filter(Boolean).join('; ')];
  } else {
    headers.push(['Cookie', jarPart]);
  }
  return { ...req, headers };
}

/** Write a response's Set-Cookie headers into the browser jar (so the tabs see them too). */
async function storeCookies(jar: Session, url: string, headers: Header[]): Promise<void> {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const c = parseSetCookie(v);
    if (!c) continue;
    try {
      await jar.cookies.set({ url, ...c });
    } catch (e) {
      console.warn('[api] cookie not stored:', (e as Error).message);
    }
  }
}

/** Parse one Set-Cookie header into Electron's CookiesSetDetails (minus url). */
export function parseSetCookie(raw: string): Omit<Electron.CookiesSetDetails, 'url'> | null {
  const [pair, ...attrs] = raw.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const out: Omit<Electron.CookiesSetDetails, 'url'> = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  for (const a of attrs) {
    const [rk, ...rv] = a.split('=');
    const key = rk.trim().toLowerCase();
    const val = rv.join('=').trim();
    if (key === 'domain' && val) out.domain = val;
    else if (key === 'path' && val) out.path = val;
    else if (key === 'secure') out.secure = true;
    else if (key === 'httponly') out.httpOnly = true;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) out.expirationDate = Date.now() / 1000 + Number(val);
    else if (key === 'expires' && !out.expirationDate) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) out.expirationDate = t / 1000;
    } else if (key === 'samesite') {
      const s = val.toLowerCase();
      out.sameSite = s === 'strict' ? 'strict' : s === 'lax' ? 'lax' : s === 'none' ? 'no_restriction' : undefined;
    }
  }
  return out;
}
