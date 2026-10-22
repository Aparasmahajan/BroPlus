// VMP signing through castlabs EVS (https://github.com/castlabs/electron-releases/wiki/EVS).
//
// Bro runs on castlabs' Electron build, which ships Google's Widevine CDM. Its electron.exe only
// carries a *development* VMP signature; Netflix (and other big services) refuse licences to that
// (the title fails with E100 / M7701-…). A free EVS account signs it for production.
//
//   npm run vmp -- signup        once: create the EVS account (asks for e-mail + password)
//   npm run vmp -- login         when EVS says the login has expired
//   npm run vmp                  sign node_modules/electron/dist (redo after reinstalling electron)
//   npm run vmp -- sign <dir>    sign another package (electron-builder's afterPack does this)
//   npm run vmp -- verify [dir]  show whether a package's signature is development or production
//
// EVS is a Python tool. On Windows, when no real Python is installed, a private embeddable Python
// is set up in %LOCALAPPDATA%\bro-dev\python. Downloads and EVS requests trust the OS certificate
// store too, so a TLS-inspecting corporate proxy works.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const PY_VERSION = '3.12.10';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'bro-dev');

const CA = [...new Set([...tls.rootCertificates, ...(tls.getCACertificates?.('system') ?? [])])];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca: CA }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).href, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env(), ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} exited with ${r.status}`);
}

/** Python's ssl/requests only know certifi's list: hand them the OS store as well. */
function env() {
  const pem = path.join(home, 'ca.pem');
  if (!fs.existsSync(pem)) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pem, CA.join('\n'));
  }
  return { ...process.env, SSL_CERT_FILE: pem, REQUESTS_CA_BUNDLE: pem, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
}

function works(py) {
  const r = spawnSync(py, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '3';
}

async function python() {
  if (process.env.BRO_PYTHON) return process.env.BRO_PYTHON;
  const own = path.join(home, 'python', 'python.exe');
  if (fs.existsSync(own)) return own;
  // The WindowsApps python.exe is a Store placeholder that fails; `works` filters it out.
  for (const py of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) if (works(py)) return py;
  if (process.platform !== 'win32') throw new Error('Python 3 is needed for EVS: install it, then run this again.');

  console.log(`Setting up a private Python ${PY_VERSION} for EVS in ${path.dirname(own)} …`);
  const dir = path.dirname(own);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(home, 'python.zip');
  await download(`https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`, zip);
  run('tar', ['-xf', zip, '-C', dir]);
  fs.rmSync(zip);
  // The embeddable build ignores site-packages until `import site` is switched on.
  const pth = fs.readdirSync(dir).find((f) => f.endsWith('._pth'));
  const file = path.join(dir, pth);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^#\s*import site/m, 'import site'));
  const getPip = path.join(home, 'get-pip.py');
  await download('https://bootstrap.pypa.io/get-pip.py', getPip);
  run(own, [getPip, '--no-warn-script-location']);
  fs.rmSync(getPip);
  return own;
}

async function evs() {
  const py = await python();
  const ok = spawnSync(py, ['-c', 'import castlabs_evs'], { env: env() }).status === 0;
  if (!ok) run(py, ['-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', 'castlabs-evs']);
  return py;
}

export async function account(action) {
  run(await evs(), ['-m', 'castlabs_evs.account', action]);
}

/** Production-sign an Electron package directory (the folder holding electron.exe / Bro.exe). */
export async function signPkg(dir) {
  run(await evs(), ['-m', 'castlabs_evs.vmp', 'sign-pkg', dir]);
}

export async function verifyPkg(dir) {
  run(await evs(), ['-m', 'castlabs_evs.vmp', 'verify-pkg', dir]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = 'sign', arg] = process.argv.slice(2);
  try {
    if (cmd === 'signup') await account('signup');
    else if (cmd === 'login') await account('reauth');
    else if (cmd === 'sign' || cmd === 'verify') {
      const dir = path.resolve(arg ?? path.join(root, 'node_modules', 'electron', 'dist'));
      await (cmd === 'sign' ? signPkg : verifyPkg)(dir);
    } else throw new Error(`unknown command "${cmd}" (use signup, login, sign [dir] or verify [dir])`);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}
