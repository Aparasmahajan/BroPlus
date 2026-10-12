// HttpEngine — the API client / Repeater sender (ARCHITECTURE.md §5.1).
//
// Runs in MAIN (Node), so it can send any method with any headers to any origin
// with no CORS — that is what makes it Postman-class, not a web page. undici is
// Node's own HTTP client and preserves response-header fidelity (duplicates
// included) better than the renderer's fetch.
//
// Phase 0: a straight send. Later: shared-session cookie jar, "fire through the
// intercept proxy", redirect/timeout/retry policy, and ${vault:}/${env:} secret
// expansion before the request leaves the machine.
import { request, type Dispatcher } from 'undici';
import { randomUUID } from 'node:crypto';
import type { HttpExchange, HttpRequest, Header } from '../../shared/http-model';

/** Hard ceiling so a huge response can't OOM the UI (ARCHITECTURE.md §5.1). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export class HttpEngine {
  async send(req: HttpRequest): Promise<HttpExchange> {
    const started = Date.now();

    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k] = v;

    const body =
      req.body && (req.body.kind === 'json' || req.body.kind === 'text' || req.body.kind === 'form')
        ? req.body.text
        : req.body?.b64
          ? Buffer.from(req.body.b64, 'base64')
          : undefined;

    const res = await request(req.url, {
      method: req.method as Dispatcher.HttpMethod,
      headers,
      body,
    });

    // Collect raw bytes up to the cap.
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = 0;
    for await (const chunk of res.body) {
      const buf = chunk as Buffer;
      if (total < MAX_BODY_BYTES) {
        const room = MAX_BODY_BYTES - total;
        chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      } else {
        truncated += buf.length;
      }
      total += buf.length;
    }
    const bodyBuf = Buffer.concat(chunks);

    const respHeaders: Header[] = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const vv of v) respHeaders.push([k, vv]);
      else if (v != null) respHeaders.push([k, String(v)]);
    }

    const u = new URL(req.url);
    return {
      id: randomUUID(),
      origin: 'api',
      request: req,
      response: {
        status: res.statusCode,
        statusText: '',
        headers: respHeaders,
        body: { b64: bodyBuf.toString('base64'), truncatedBytes: truncated || undefined },
        timingMs: Date.now() - started,
      },
      meta: {
        startedAt: started,
        host: u.host,
        scheme: u.protocol === 'https:' ? 'https' : 'http',
      },
    };
  }
}
