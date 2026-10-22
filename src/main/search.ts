import { JsonStore } from './store';
import { Event, type SearchConfig, type SearchEngine } from '../shared/ipc-contract';
import { DEFAULT_SEARCH, engineProblem } from '../shared/search';

export { DEFAULT_SEARCH };

/** Omnibox search engines + site-search keywords ("yt lofi"), persisted. */
export class SearchSettings {
  private store: JsonStore<SearchConfig>;

  constructor(private emit: (channel: string, payload: unknown) => void) {
    this.store = new JsonStore<SearchConfig>('search', DEFAULT_SEARCH);
  }

  get(): SearchConfig {
    return this.store.get();
  }

  set(cfg: SearchConfig): void {
    const seen = new Set<string>();
    const engines: SearchEngine[] = [];
    for (const e of cfg.engines ?? []) {
      const keyword = String(e.keyword ?? '').trim().replace(/^!/, '');
      const url = String(e.url ?? '').trim();
      // Keyword is the first word of the omnibox input, so no spaces; URL needs a %s slot.
      if (engineProblem(keyword, url)) continue;
      if (seen.has(keyword.toLowerCase())) continue;
      seen.add(keyword.toLowerCase());
      engines.push({ keyword, name: String(e.name ?? '').trim() || keyword, url });
    }
    if (!engines.length) engines.push(...DEFAULT_SEARCH.engines);
    const defaultKeyword = engines.some((e) => e.keyword === cfg.defaultKeyword)
      ? cfg.defaultKeyword
      : engines[0].keyword;

    const next = { engines, defaultKeyword };
    this.store.set(next);
    this.emit(Event.SearchChanged, next);
  }

  flush(): void {
    this.store.flush();
  }
}
