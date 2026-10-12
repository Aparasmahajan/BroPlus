// Browser chrome: renders the tab strip + toolbar and drives navigation via the
// typed `window.bro` bridge. The screen-share control is NOT here — it lives on
// the Settings page (gear button / Ctrl/Cmd+Shift+S).
import { type TabState, type PluginInfo } from '../shared/ipc-contract';

const bro = window.bro;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const isMac = bro.platform === 'darwin';
if (isMac) document.body.classList.add('is-mac'); // native traffic lights → hide ours

// --- Window controls -------------------------------------------------------
$('btn-min').addEventListener('click', () => bro.minimize());
$('btn-max').addEventListener('click', () => bro.toggleMaximize());
$('btn-close').addEventListener('click', () => bro.close());

// --- Toolbar actions -------------------------------------------------------
$('btn-back').addEventListener('click', () => bro.goBack());
$('btn-forward').addEventListener('click', () => bro.goForward());
$('btn-reload').addEventListener('click', () => bro.reload());
$('new-tab').addEventListener('click', () => bro.newTab());
$('btn-settings').addEventListener('click', () => bro.toggleSettings());

// --- Omnibox ---------------------------------------------------------------
const omnibox = $<HTMLInputElement>('omnibox');
let omniboxEditing = false;
omnibox.addEventListener('focus', () => {
  omniboxEditing = true;
  omnibox.select();
});
omnibox.addEventListener('blur', () => (omniboxEditing = false));
omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    bro.navigate(omnibox.value);
    omnibox.blur();
  } else if (e.key === 'Escape') {
    omnibox.blur();
  }
});

bro.onFocusOmnibox(() => {
  omnibox.focus();
  omnibox.select();
});

// --- Tab strip + state sync ------------------------------------------------
const tabsEl = $('tabs');
const back = $<HTMLButtonElement>('btn-back');
const forward = $<HTMLButtonElement>('btn-forward');

function render(tabs: TabState[]): void {
  // Tabs
  tabsEl.replaceChildren();
  for (const t of tabs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.active ? ' active' : '');
    tab.title = t.url || t.title;

    if (t.favicon) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = t.favicon;
      img.onerror = () => img.remove();
      tab.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = t.loading ? 'spinner' : 'favicon-placeholder';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'tab-title';
    label.textContent = t.title;
    tab.appendChild(label);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      bro.closeTab(t.id);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => bro.activateTab(t.id));
    tabsEl.appendChild(tab);
  }

  // Toolbar reflects the active tab.
  const active = tabs.find((t) => t.active);
  if (active) {
    if (!omniboxEditing) omnibox.value = active.url;
    back.disabled = !active.canGoBack;
    forward.disabled = !active.canGoForward;
  }
}

bro.onTabsChanged(render);
void bro.listTabs().then(render);

// --- Mode switch (Browse + plugin surfaces) --------------------------------
// Built from the plugins actually present in THIS build: a surface plugin that
// was excluded simply never shows a button.
const modeSwitch = document.getElementById('mode-switch');
let currentMode = 'browse';

function renderModes(infos: PluginInfo[]): void {
  if (!modeSwitch) return;
  modeSwitch.replaceChildren();
  const mk = (mode: string, label: string) => {
    const b = document.createElement('button');
    b.className = 'mode-btn' + (mode === currentMode ? ' active' : '');
    b.textContent = label;
    b.dataset.mode = mode;
    b.addEventListener('click', () => bro.setMode(mode));
    modeSwitch.appendChild(b);
  };
  mk('browse', 'Browse');
  for (const p of infos) if (p.surface) mk(p.surface.mode, p.surface.label);
}

bro.onModeChanged((m) => {
  currentMode = m;
  modeSwitch?.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === m),
  );
});

void bro.activePlugins().then(renderModes);
