// Built-in omnibox search engines. Shared so Settings can offer "Restore defaults".
import type { SearchConfig } from './ipc-contract';

export const DEFAULT_SEARCH: SearchConfig = {
  defaultKeyword: 'g',
  engines: [
    { keyword: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { keyword: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { keyword: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
    { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
    { keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
    { keyword: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
    { keyword: 'r', name: 'Reddit', url: 'https://www.reddit.com/search/?q=%s' },
    { keyword: 'so', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=%s' },
    { keyword: 'maps', name: 'Google Maps', url: 'https://www.google.com/maps/search/%s' },
    { keyword: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q=%s' },
    { keyword: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q=%s' },
  ],
};

/** Why an engine can't be saved, or null if it's fine. Main applies the same rules. */
export function engineProblem(keyword: string, url: string): string | null {
  if (!keyword.trim()) return 'Keyword is required';
  if (/\s/.test(keyword.trim())) return 'Keyword can’t contain spaces';
  if (!/^https?:\/\//i.test(url.trim())) return 'URL must start with https://';
  if (!url.includes('%s')) return 'URL needs %s where the search terms go';
  return null;
}
