import type { MainWindow } from './window';
import type { Browser } from './browser';
import { OPACITY_STEP } from './window';
import type { CommandId } from '../shared/shortcuts';

/**
 * What every built-in shortcut does, keyed by the registry ids in
 * shared/shortcuts.ts. The Record type makes the compiler insist that each
 * registered command has a handler.
 */
export function commandHandlers(mw: MainWindow, browser: Browser): Record<CommandId, () => void> {
  const tabs = () => browser.tabs;
  return {
    'stealth.toggleCapture': () => mw.toggleCaptureHidden(),
    'stealth.opacityUp': () => mw.nudgeOpacity(+OPACITY_STEP),
    'stealth.opacityDown': () => mw.nudgeOpacity(-OPACITY_STEP),
    'stealth.opacityReset': () => mw.setOpacity(1.0),
    'stealth.toggleOverlay': () => mw.toggleOverlayMode(),
    'stealth.bossKey': () => mw.toggleHidden(),
    'stealth.toggleSettings': () => browser.toggleSettings(),

    'tab.new': () => {
      tabs().newTab();
      browser.focusOmnibox(); // start typing straight away, like Chrome
    },
    'tab.newPrivate': () => {
      tabs().newTab(undefined, { private: true });
      browser.focusOmnibox();
    },
    'tab.close': () => tabs().closeActive(),
    'tab.reopenClosed': () => tabs().reopenClosed(),
    'tab.duplicate': () => tabs().duplicate(),
    'tab.next': () => tabs().cycle(+1),
    'tab.prev': () => tabs().cycle(-1),
    'tab.goto1': () => tabs().activateIndex(0),
    'tab.goto2': () => tabs().activateIndex(1),
    'tab.goto3': () => tabs().activateIndex(2),
    'tab.goto4': () => tabs().activateIndex(3),
    'tab.goto5': () => tabs().activateIndex(4),
    'tab.goto6': () => tabs().activateIndex(5),
    'tab.goto7': () => tabs().activateIndex(6),
    'tab.goto8': () => tabs().activateIndex(7),
    'tab.gotoLast': () => tabs().activateIndex(-1),

    'nav.back': () => tabs().back(),
    'nav.forward': () => tabs().forward(),
    'nav.reload': () => tabs().reload(),
    'nav.hardReload': () => tabs().reload(undefined, true),
    'nav.focusAddress': () => browser.focusOmnibox(),
    'nav.home': () => tabs().navigate(''),

    'page.find': () => browser.showFind(),
    'page.findNext': () => browser.findAgain(true),
    'page.findPrev': () => browser.findAgain(false),
    'page.zoomIn': () => tabs().zoom(+1),
    'page.zoomOut': () => tabs().zoom(-1),
    'page.zoomReset': () => tabs().zoom(0),
    'page.fullscreen': () => mw.toggleFullScreen(),
    'page.print': () => tabs().activeWebContents?.print(),
    'page.viewSource': () => tabs().viewSource(),
    'page.devtools': () => tabs().activeWebContents?.toggleDevTools(),
    'page.saveOffline': () => browser.saveOffline('page+video'),

    'app.bookmark': () => browser.bookmarkActiveTab(),
    'app.library': () => browser.toggleLibrary(),
    'app.history': () => browser.openLibrary('history'),
    'app.downloads': () => browser.openLibraryTab('downloads'),
    'app.offline': () => browser.openLibraryTab('offline'),
    'app.saveSession': () => browser.saveSessionNow(),
    'app.settings': () => browser.toggleSettings(),
  };
}
