// Repeat "Ctrl+T, then Ctrl+W as soon as the tab exists" and check the main process survives
// and every round ends where it started. Against a running Bro Plus (main :9229).
// usage: node open-close-stress.mjs <iterations> <delayBeforeCloseMs>
import { connectMain, chromeEval, checker } from './lib.mjs';
const [, , N = '8', DELAY = '0'] = process.argv;
const { main, M } = await connectMain();
await chromeEval(M);
main.ws.onclose = () => { console.log('FAIL  main process connection lost (crash?)'); process.exit(2); };
const { check, done } = checker();

let bad = 0;
for (let i = 1; i <= Number(N); i++) {
  const r = await M(`
    const c = E.webContents.getAllWebContents().find(w => w.getURL().endsWith('dist/ui/index.html'));
    const count = () => c.executeJavaScript('document.querySelectorAll("#tabs .tab").length');
    const key = (k) => { c.focus(); c.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); c.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); };
    const n = await count();
    key('T');
    let opened = false;
    for (let j = 0; j < 400; j++) { if ((await count()) === n + 1) { opened = true; break; } await wait(25); }
    await wait(${Number(DELAY)});
    key('W');
    for (let j = 0; j < 400 && (await count()) !== n; j++) await wait(25);
    return { n, opened, after: await count() };`);
  const ok = r.opened && r.after === r.n;
  if (!ok) bad++;
  console.log(`iteration ${i}: ${r.n} -> ${r.after}${r.opened ? '' : ' (tab never appeared)'}`);
}
check(`${N} × open-then-close-at-once: the main process survives`, true);
check('…and every round opens one tab and closes it again', bad === 0, `${bad} bad round(s)`);
done();
