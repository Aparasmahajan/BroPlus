// usage: node maineval.mjs "<expr>"  — evaluates in the Electron MAIN process (inspector on BRO_E2E_INSPECT_PORT, default 9229).
// `require` works at the top level of the expression (includeCommandLineAPI).
import { MAIN_URL, connect } from './lib.mjs';
const list = await (await fetch(`${MAIN_URL}/json/list`)).json();
const main = await connect(list[0].webSocketDebuggerUrl);
const out = await main.evaluate(process.argv[2]).catch((e) => 'ERR ' + e.message);
console.log(typeof out === 'string' ? out : JSON.stringify(out));
process.exit(0);
