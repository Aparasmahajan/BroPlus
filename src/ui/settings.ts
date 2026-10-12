// Settings page (its own overlay view). A CORE shell that reveals a section per
// capability plugin actually present in this build (overlay-hiding, opacity) and
// drives them through the generic plugin bus. A build without a plugin simply
// never shows its section.
import { type PluginInfo } from '../shared/ipc-contract';

const bro = window.bro;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const isMac = bro.platform === 'darwin';
if (isMac) {
  document.querySelectorAll('kbd.mod').forEach((k) => (k.textContent = 'Cmd'));
}

$('close').addEventListener('click', () => bro.closeSettings());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bro.closeSettings();
});

// --- Screen-share invisibility (overlay-hiding plugin) ---------------------
function wireOverlay(): void {
  $('sec-overlay').removeAttribute('hidden');
  const pill = $('capture-pill');
  const text = $('capture-text');
  const detail = $('capture-detail');

  const render = (hidden: boolean) => {
    pill.setAttribute('aria-checked', String(hidden));
    text.textContent = hidden ? 'ON' : 'OFF';
    detail.textContent = hidden
      ? isMac
        ? 'NSWindowSharingNone — excluded from macOS capture'
        : 'WDA_EXCLUDEFROMCAPTURE — excluded from Windows capture'
      : 'Currently visible to screen share';
  };

  pill.addEventListener('click', () =>
    bro.plugin.send('overlay:set', pill.getAttribute('aria-checked') !== 'true'),
  );
  bro.plugin.on<boolean>('overlay:changed', render);
  void bro.plugin.invoke<boolean>('overlay:get').then(render);
}

// --- Opacity (opacity plugin) ----------------------------------------------
function wireOpacity(): void {
  $('sec-opacity').removeAttribute('hidden');
  const slider = $<HTMLInputElement>('opacity');
  const val = $('opacity-val');

  const render = (v: number) => {
    slider.value = String(v);
    val.textContent = `${Math.round(v * 100)}%`;
  };

  slider.addEventListener('input', () => bro.plugin.send('opacity:set', parseFloat(slider.value)));
  bro.plugin.on<number>('opacity:changed', render);
  void bro.plugin.invoke<number>('opacity:get').then(render);
}

// Reveal only the sections whose plugins shipped in this build.
void bro.activePlugins().then((infos: PluginInfo[]) => {
  const ids = new Set(infos.map((p) => p.id));
  if (ids.has('overlay-hiding')) wireOverlay();
  if (ids.has('opacity')) wireOpacity();
});
