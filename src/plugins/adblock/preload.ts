// YouTube ad shield. A session-level frame preload (registered by AdBlock while
// blocking is on) that runs in every page BEFORE the page's own scripts, and
// only does anything on YouTube.
//
// Why it exists: YouTube serves ads from the same servers as the videos, so
// network filters can't block them; ad breaks are listed in the player's data
// instead. The filter lists' fix ("json-prune" scriptlets) reaches the page via
// an async IPC round trip — after YouTube has already read that data. Here we
// install the pruning straight into the page's world, synchronously, first.
import { contextBridge, webFrame } from 'electron';

const YOUTUBE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;

/** Feed / banner / sidebar ad containers + the "ad blockers not allowed" wall. */
const HIDE_CSS = `
#masthead-ad, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer,
ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-companion-slot-renderer,
ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer, #player-ads,
ytd-banner-promo-renderer, ytd-statement-banner-renderer, ytd-search-pyv-renderer,
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
ytd-rich-item-renderer:has(ytd-ad-slot-renderer), ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
.ytp-ad-overlay-container, .ytp-ad-image-overlay, ad-slot-renderer, ytm-promoted-sparkles-web-renderer,
ytm-companion-ad-renderer, tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)
{ display: none !important; }
`;

/**
 * Runs in YouTube's own JS world. It is serialized and re-evaluated there, so it
 * must be fully self-contained (no outer variables or imports).
 */
function pruneAdsInPage(): void {
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];

  // Remove ad breaks from a player response (or something that wraps one).
  const prune = (o: unknown, depth = 0): void => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (Array.isArray(o)) {
      for (const x of o) prune(x, depth + 1);
      return;
    }
    const rec = o as Record<string, unknown>;
    for (const k of AD_KEYS) if (k in rec) delete rec[k];
    if (rec.playerResponse) prune(rec.playerResponse, depth + 1);
  };

  // 1. The first page load: `var ytInitialPlayerResponse = {...}` in an inline
  //    script. A pre-defined accessor turns that assignment into a call to us.
  let initial: unknown;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (v) => {
        prune(v);
        initial = v;
      },
    });
  } catch {
    /* already defined — fall through to the parse hooks */
  }

  // 2. In-app navigation: the player fetches /youtubei/v1/player and parses it.
  //    Proxies keep the natives' identity (toString etc.) intact.
  JSON.parse = new Proxy(JSON.parse, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      prune(result);
      return result;
    },
  });
  const proto = Response.prototype;
  proto.json = new Proxy(proto.json, {
    apply(target, thisArg, args) {
      return (Reflect.apply(target, thisArg, args) as Promise<unknown>).then((r) => {
        prune(r);
        return r;
      });
    },
  });
}

/**
 * Safety net for ads that still play (e.g. stitched into the video stream):
 * mute, jump to the end, press Skip, then restore the sound. Also clears the
 * anti-adblock wall if YouTube shows it. Runs in the preload's own world — it
 * only needs the DOM.
 */
function skipLeftoverAds(): void {
  let mutedBefore: boolean | null = null;
  const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';
  setInterval(() => {
    const player = document.getElementById('movie_player');
    const video = player?.querySelector('video');
    const inAd = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
    if (inAd && video) {
      if (mutedBefore === null) mutedBefore = video.muted;
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.3) {
        video.currentTime = video.duration - 0.1;
      }
      document.querySelector<HTMLElement>(SKIP)?.click();
    } else if (mutedBefore !== null) {
      if (video) video.muted = mutedBefore;
      mutedBefore = null;
    }

    const wall = document.querySelector('ytd-enforcement-message-view-model');
    if (wall) {
      wall.closest('tp-yt-paper-dialog')?.remove();
      document.querySelector('tp-yt-iron-overlay-backdrop')?.remove();
      if (video?.paused) void video.play().catch(() => {});
    }
  }, 300);
}

if (YOUTUBE.test(location.hostname)) {
  try {
    contextBridge.executeInMainWorld({ func: pruneAdsInPage });
  } catch (e) {
    console.warn('[bro] YouTube ad shield could not start', e);
  }
  webFrame.insertCSS(HIDE_CSS, { cssOrigin: 'user' });
  skipLeftoverAds();
}
