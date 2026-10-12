// InterceptProxy engine (ARCHITECTURE.md §6), built on mockttp.
//
// Starts a local HTTPS-intercepting proxy, points the shared Electron session at
// it, and trusts the generated MITM leaf certs for THIS session only (no OS
// trust-store change). Captures every request/response as an HttpExchange, can
// hold + edit + forward/drop requests (intercept), and resends requests
// (Repeater). The CA private key lives under <configDir>/proxy/ — never in git.
//
// mockttp callback/event payload types vary across versions, so the server and
// its callbacks are typed loosely (`any`) on purpose; shapes are accessed
// defensively.
import * as mockttp from 'mockttp';
import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Session } from 'electron';
import type { HttpExchange, HttpRequest, Header } from '../../shared/http-model';

export interface InterceptPaused {
  holdId: string;
  exchange: HttpExchange;
}

interface Decision {
  forward: boolean;
  request?: HttpRequest;
}

const HISTORY_MAX = 500;

export class ProxyEngine {
  running = false;
  port = 0;
  intercept = false;
  scope: string[] = [];

  onExchange: (ex: HttpExchange) => void = () => {};
  onPaused: (p: InterceptPaused) => void = () => {};

  private server: mockttp.Mockttp | null = null;
  private history: HttpExchange[] = [];
  private pending = new Map<string, { method: string; url: string; headers: Header[]; startedAt: number }>();
  private holds = new Map<string, (d: Decision) => void>();

  constructor(
    private session: Session,
    private configDir: string,
  ) {}

  // --- CA ------------------------------------------------------------------
  private caDir(): string {
    return join(this.configDir, 'proxy');
  }

  private async loadOrMakeCA(): Promise<{ key: string; cert: string }> {
    const dir = this.caDir();
    await fs.mkdir(dir, { recursive: true });
    const keyP = join(dir, 'ca.key.pem');
    const certP = join(dir, 'ca.cert.pem');
    try {
      return { key: await fs.readFile(keyP, 'utf8'), cert: await fs.readFile(certP, 'utf8') };
    } catch {
      const ca = await mockttp.generateCACertificate();
      await fs.writeFile(keyP, ca.key);
      await fs.writeFile(certP, ca.cert);
      return { key: ca.key, cert: ca.cert };
    }
  }

  async caCertPem(): Promise<string> {
    return (await this.loadOrMakeCA()).cert;
  }

  inScope(url: string): boolean {
    if (!this.scope.length) return true;
    try {
      const h = new URL(url).host;
      return this.scope.some((s) => s && h.includes(s));
    } catch {
      return false;
    }
  }

  // --- Lifecycle -----------------------------------------------------------
  async start(): Promise<void> {
    if (this.running) return;
    const ca = await this.loadOrMakeCA();
    const server = mockttp.getLocal({ https: ca, cors: false });
    this.server = server;

    server.on('request', (req: any) => {
      try {
        this.pending.set(req.id, {
          method: req.method,
          url: req.url,
          headers: toHeaders(req.rawHeaders, req.headers),
          startedAt: Date.now(),
        });
      } catch {
        /* ignore malformed */
      }
    });

    server.on('response', async (res: any) => {
      const pend = this.pending.get(res.id);
      if (!pend) return;
      this.pending.delete(res.id);
      if (!this.inScope(pend.url)) return;
      let text = '';
      try {
        text = (await res.body.getText()) ?? '';
      } catch {
        /* binary/compressed body we can't decode to text */
      }
      this.push({
        id: res.id,
        origin: 'proxy',
        request: { method: pend.method, url: pend.url, headers: pend.headers },
        response: {
          status: res.statusCode,
          statusText: res.statusMessage ?? '',
          headers: toHeaders(res.rawHeaders, res.headers),
          body: { b64: Buffer.from(text, 'utf8').toString('base64') },
          timingMs: Date.now() - pend.startedAt,
        },
        meta: { startedAt: pend.startedAt, host: safeHost(pend.url), scheme: pend.url.startsWith('https') ? 'https' : 'http' },
      });
    });

    await server.forAnyRequest().thenPassThrough({
      beforeRequest: async (req: any) => {
        if (!this.intercept || !this.inScope(req.url)) return undefined;
        const holdId: string = req.id || randomUUID();
        let bodyText = '';
        try {
          bodyText = (await req.body.getText()) ?? '';
        } catch {
          /* ignore */
        }
        const exchange: HttpExchange = {
          id: holdId,
          origin: 'proxy',
          request: {
            method: req.method,
            url: req.url,
            headers: toHeaders(req.rawHeaders, req.headers),
            body: bodyText ? { kind: 'text', text: bodyText } : undefined,
          },
          meta: { startedAt: Date.now(), host: safeHost(req.url), scheme: req.url.startsWith('https') ? 'https' : 'http' },
        };

        const decision = await new Promise<Decision>((resolve) => {
          this.holds.set(holdId, resolve);
          this.onPaused({ holdId, exchange });
        });
        this.holds.delete(holdId);

        if (!decision.forward) {
          return { response: { statusCode: 504, headers: { 'content-type': 'text/plain' }, body: 'Dropped by Bro_plus' } };
        }
        const er = decision.request;
        if (er) {
          const hobj: Record<string, string> = {};
          for (const [k, v] of er.headers) hobj[k] = v;
          return {
            method: er.method,
            url: er.url,
            headers: hobj,
            body: er.body?.text ?? (er.body?.b64 ? Buffer.from(er.body.b64, 'base64') : undefined),
          };
        }
        return undefined;
      },
    });

    await server.start();
    this.port = server.port;
    await this.session.setProxy({ proxyRules: `http://127.0.0.1:${this.port}` });
    // Trust our MITM leaf certs — for THIS session only, no OS trust change.
    this.session.setCertificateVerifyProc((_req, cb) => cb(0));
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.session.setProxy({ mode: 'direct' });
    this.session.setCertificateVerifyProc(null);
    for (const resolve of this.holds.values()) resolve({ forward: true });
    this.holds.clear();
    await this.server?.stop();
    this.server = null;
    this.running = false;
    this.port = 0;
  }

  resolveHold(holdId: string, forward: boolean, req?: HttpRequest): void {
    this.holds.get(holdId)?.({ forward, request: req });
  }

  // --- Repeater ------------------------------------------------------------
  async repeater(req: HttpRequest): Promise<HttpExchange> {
    const started = Date.now();
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k] = v;
    const body = req.body?.text ?? (req.body?.b64 ? Buffer.from(req.body.b64, 'base64') : undefined);
    const res = await request(req.url, { method: req.method as never, headers, body });
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const rh: Header[] = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) v.forEach((x) => rh.push([k, x]));
      else if (v != null) rh.push([k, String(v)]);
    }
    const ex: HttpExchange = {
      id: randomUUID(),
      origin: 'repeater',
      request: req,
      response: {
        status: res.statusCode,
        statusText: '',
        headers: rh,
        body: { b64: buf.toString('base64') },
        timingMs: Date.now() - started,
      },
      meta: { startedAt: started, host: safeHost(req.url), scheme: req.url.startsWith('https') ? 'https' : 'http' },
    };
    this.push(ex);
    return ex;
  }

  list(): HttpExchange[] {
    return this.history;
  }
  clear(): void {
    this.history = [];
  }

  private push(ex: HttpExchange): void {
    this.history.unshift(ex);
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    this.onExchange(ex);
  }
}

function toHeaders(rawHeaders: unknown, headers: unknown): Header[] {
  if (Array.isArray(rawHeaders)) {
    return (rawHeaders as [string, string][]).map((p) => [String(p[0]), String(p[1])] as Header);
  }
  const out: Header[] = [];
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((x) => out.push([k, String(x)]));
      else if (v != null) out.push([k, String(v)]);
    }
  }
  return out;
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
