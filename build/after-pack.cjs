// electron-builder afterPack hook: VMP-sign the packed app for production (see scripts/evs.mjs),
// otherwise Netflix refuses to play in the installed Bro. It runs before the installer is built.
// macOS: this must happen before code signing, which afterPack is. Windows: if an Authenticode
// certificate is ever added, VMP signing has to move after that signature (afterSign).
// BRO_SKIP_VMP=1 packs without it (Widevine still loads; Netflix-style services won't play).
const path = require('node:path');
const { pathToFileURL } = require('node:url');

exports.default = async function afterPack(context) {
  if (process.env.BRO_SKIP_VMP === '1') {
    console.warn('  • BRO_SKIP_VMP=1: package is NOT VMP-signed, Netflix will not play in it');
    return;
  }
  const { signPkg } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'evs.mjs')).href);
  const dir =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir;
  await signPkg(dir);
};
