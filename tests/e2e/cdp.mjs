// usage: node cdp.mjs <url-substring> <js-expression>   (evaluates in every page whose URL matches; '*' = all)
import { CDP_URL, connect, pageTargets } from './lib.mjs';
const [, , match, expr] = process.argv;
const targets = (await pageTargets()).filter((t) => match === '*' || t.url.includes(match));
if (!targets.length) console.log(`no page matches "${match}" on ${CDP_URL}`);
for (const t of targets) {
  const c = await connect(t.webSocketDebuggerUrl);
  const out = await c.evaluate(expr).catch((e) => 'ERR ' + e.message);
  console.log(`[${t.url.split('/').pop() || '(blank)'}]`, JSON.stringify(out));
  c.ws.close();
}
