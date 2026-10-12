// The one HTTP record every surface speaks (ARCHITECTURE.md §3). The browser,
// the API client and the proxy all produce and consume `HttpExchange`, so an
// action like "send this captured request to the API client" is just handing
// the same object across surfaces.

/** Headers are an ORDERED list that may repeat a key (Set-Cookie, Via, …).
 *  Never collapse into a Record — order + duplicates are Burp-grade fidelity. */
export type Header = [name: string, value: string];

export interface HttpBody {
  kind: 'text' | 'json' | 'form' | 'binary';
  /** Present for text/json/form. */
  text?: string;
  /** Present for binary (and how any body is carried over IPC losslessly). */
  b64?: string;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Header[];
  body?: HttpBody;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Header[];
  /** Raw bytes, base64. Decoded for display; never eval'd. */
  body: { b64: string; truncatedBytes?: number };
  timingMs: number;
  fromCache?: boolean;
}

export type ExchangeOrigin = 'browse' | 'api' | 'repeater' | 'proxy';

export interface HttpExchange {
  id: string;
  origin: ExchangeOrigin;
  request: HttpRequest;
  response?: HttpResponse;
  meta: {
    startedAt: number;
    host: string;
    scheme: 'http' | 'https';
    notes?: string;
  };
}

/** The three top-level surfaces of Bro_plus. */
export type Mode = 'browse' | 'api' | 'proxy';
