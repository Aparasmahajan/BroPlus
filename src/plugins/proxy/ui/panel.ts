// Proxy panel (Burp-class). Start/stop the MITM proxy, watch the live HTTP
// history, intercept + edit + forward/drop requests, and resend via Repeater.
import type { HttpExchange, HttpRequest, Header } from '../../../shared/ipc-contract';

interface Paused {
  holdId: string;
  exchange: HttpExchange;
}
interface Status {
  running: boolean;
  port: number;
  intercept: boolean;
  scope: string[];
}

const bro = window.bro;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let running = false;
let currentHold: Paused | null = null;

// --- helpers ---------------------------------------------------------------
function b64ToText(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}
function pretty(t: string): string {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}
function headersToText(h: Header[]): string {
  return h.map(([k, v]) => `${k}: ${v}`).join('\n');
}
function textToHeaders(t: string): Header[] {
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return i < 0 ? ([l, ''] as Header) : ([l.slice(0, i).trim(), l.slice(i + 1).trim()] as Header);
    });
}
function curlOf(ex: HttpExchange): string {
  const r = ex.request;
  const parts = [`curl -X ${r.method} ${JSON.stringify(r.url)}`];
  for (const [k, v] of r.headers) parts.push(`-H ${JSON.stringify(`${k}: ${v}`)}`);
  if (r.body?.text) parts.push(`--data ${JSON.stringify(r.body.text)}`);
  return parts.join(' \\\n  ');
}

// --- start / stop / intercept / scope --------------------------------------
async function refreshStatus(): Promise<void> {
  const s = await bro.plugin.invoke<Status>('proxy:status');
  running = s.running;
  $('toggle').textContent = running ? 'Stop proxy' : 'Start proxy';
  $('pstatus').textContent = running ? `running · 127.0.0.1:${s.port}` : 'stopped';
  ($('intercept') as HTMLInputElement).checked = s.intercept;
  ($('scope') as HTMLInputElement).value = s.scope.join(', ');
}

$('toggle').addEventListener('click', async () => {
  $('toggle').setAttribute('disabled', 'true');
  try {
    await bro.plugin.invoke(running ? 'proxy:stop' : 'proxy:start');
  } catch (e) {
    $('pstatus').textContent = `error: ${String(e)}`;
  }
  $('toggle').removeAttribute('disabled');
  void refreshStatus();
});

$('intercept').addEventListener('change', () => {
  bro.plugin.send('proxy:intercept-set', ($('intercept') as HTMLInputElement).checked);
});
$('scope').addEventListener('change', () => {
  const list = ($('scope') as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
  bro.plugin.send('proxy:scope-set', list);
});
$('clear').addEventListener('click', () => {
  bro.plugin.send('proxy:clear');
  $('hist').replaceChildren();
  $('detail').replaceChildren(Object.assign(document.createElement('div'), { className: 'tree-empty', textContent: 'Cleared.' }));
});
$('ca').addEventListener('click', async () => {
  const pem = await bro.plugin.invoke<string>('proxy:ca');
  showDetailText('CA certificate (PEM) — install in your OS trust store only if you need to capture OTHER apps; remove when done.\n\n' + pem);
});

// --- history ---------------------------------------------------------------
function addRow(ex: HttpExchange, prepend = true): void {
  const row = document.createElement('div');
  row.className = 'tree-req';
  const st = ex.response?.status ?? 0;
  row.innerHTML =
    `<span class="m m-${ex.request.method.toLowerCase()}">${ex.request.method}</span>` +
    `<span class="h-st ${st && st < 400 ? 'ok' : 'bad'}">${st || '…'}</span>` +
    (ex.origin === 'repeater' ? `<span class="badge">R</span>` : '');
  const name = document.createElement('span');
  name.className = 'tree-req-name';
  name.textContent = ex.request.url;
  row.appendChild(name);
  row.addEventListener('click', () => renderDetail(ex));
  if (prepend) $('hist').prepend(row);
  else $('hist').appendChild(row);
}

function showDetailText(text: string): void {
  const pre = document.createElement('pre');
  pre.className = 'out';
  pre.textContent = text;
  $('detail').replaceChildren(pre);
}

function renderDetail(ex: HttpExchange): void {
  const d = $('detail');
  d.replaceChildren();

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const toRep = document.createElement('button');
  toRep.className = 'mini-btn';
  toRep.textContent = 'Send to Repeater';
  toRep.addEventListener('click', () => loadRepeater(ex));
  const copy = document.createElement('button');
  copy.className = 'mini-btn';
  copy.textContent = 'Copy as curl';
  copy.addEventListener('click', () => void navigator.clipboard?.writeText(curlOf(ex)).catch(() => {}));
  actions.append(toRep, copy);
  d.appendChild(actions);

  const reqText =
    `${ex.request.method} ${ex.request.url}\n` +
    headersToText(ex.request.headers) +
    (ex.request.body?.text ? `\n\n${ex.request.body.text}` : '');
  const resText = ex.response
    ? `HTTP ${ex.response.status} ${ex.response.statusText} · ${ex.response.timingMs} ms\n` +
      headersToText(ex.response.headers) +
      `\n\n${pretty(b64ToText(ex.response.body.b64))}`
    : '(no response — still in flight or dropped)';

  d.appendChild(section('Request', reqText));
  d.appendChild(section('Response', resText));
}
function section(title: string, body: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'detail-sec';
  const h = document.createElement('div');
  h.className = 'detail-h';
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.className = 'out';
  pre.textContent = body;
  wrap.append(h, pre);
  return wrap;
}

bro.plugin.on<HttpExchange>('proxy:exchange', (ex) => addRow(ex, true));

// --- intercept hold --------------------------------------------------------
bro.plugin.on<Paused>('proxy:paused', (p) => {
  currentHold = p;
  const bar = $('intercept-bar');
  bar.hidden = false;
  $('ib-method').textContent = p.exchange.request.method;
  ($('ib-url') as HTMLInputElement).value = p.exchange.request.url;
  ($('ib-headers') as HTMLTextAreaElement).value = headersToText(p.exchange.request.headers);
  ($('ib-body') as HTMLTextAreaElement).value = p.exchange.request.body?.text ?? '';
});

function closeIntercept(): void {
  currentHold = null;
  $('intercept-bar').hidden = true;
}
$('ib-forward').addEventListener('click', () => {
  if (!currentHold) return;
  const req: HttpRequest = {
    method: currentHold.exchange.request.method,
    url: ($('ib-url') as HTMLInputElement).value,
    headers: textToHeaders(($('ib-headers') as HTMLTextAreaElement).value),
    body: ($('ib-body') as HTMLTextAreaElement).value ? { kind: 'text', text: ($('ib-body') as HTMLTextAreaElement).value } : undefined,
  };
  bro.plugin.send('proxy:forward', { holdId: currentHold.holdId, request: req });
  closeIntercept();
});
$('ib-drop').addEventListener('click', () => {
  if (!currentHold) return;
  bro.plugin.send('proxy:drop', currentHold.holdId);
  closeIntercept();
});

// --- views -----------------------------------------------------------------
$('v-history').addEventListener('click', () => switchView('history'));
$('v-repeater').addEventListener('click', () => switchView('repeater'));
function switchView(v: 'history' | 'repeater'): void {
  $('v-history').classList.toggle('active', v === 'history');
  $('v-repeater').classList.toggle('active', v === 'repeater');
  $('view-history').hidden = v !== 'history';
  $('view-repeater').hidden = v !== 'repeater';
}

// --- repeater --------------------------------------------------------------
function loadRepeater(ex: HttpExchange): void {
  switchView('repeater');
  ($('rep-method') as HTMLSelectElement).value = ex.request.method;
  ($('rep-url') as HTMLInputElement).value = ex.request.url;
  ($('rep-headers') as HTMLTextAreaElement).value = headersToText(ex.request.headers);
  ($('rep-body') as HTMLTextAreaElement).value = ex.request.body?.text ?? '';
}
$('rep-send').addEventListener('click', async () => {
  const req: HttpRequest = {
    method: ($('rep-method') as HTMLSelectElement).value,
    url: ($('rep-url') as HTMLInputElement).value,
    headers: textToHeaders(($('rep-headers') as HTMLTextAreaElement).value),
    body: ($('rep-body') as HTMLTextAreaElement).value ? { kind: 'text', text: ($('rep-body') as HTMLTextAreaElement).value } : undefined,
  };
  if (!req.url) return;
  $('rep-out').textContent = '…';
  try {
    const ex = await bro.plugin.invoke<HttpExchange>('proxy:repeater', req);
    const r = ex.response!;
    $('rep-out').textContent =
      `HTTP ${r.status} · ${r.timingMs} ms\n${headersToText(r.headers)}\n\n${pretty(b64ToText(r.body.b64))}`;
  } catch (e) {
    $('rep-out').textContent = String(e);
  }
});

// --- boot ------------------------------------------------------------------
void refreshStatus().then(() => bro.plugin.invoke<HttpExchange[]>('proxy:history')).then((hist) => {
  if (hist) for (const ex of [...hist].reverse()) addRow(ex, true);
});
