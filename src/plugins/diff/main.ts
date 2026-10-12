// diff — a LIBRARY plugin (ARCHITECTURE.md §A). It ships no surface and has no
// registerMain side effects; it exists in the catalog so other plugins can
// declare `dependsOn: ['diff']` and so a build that drops API + Proxy can also
// drop diff. The actual diff code lives in ./index.ts and is imported directly
// by whoever needs it.
import type { BroPlugin } from '../../core/plugin';

const plugin: BroPlugin = {
  manifest: {
    id: 'diff',
    title: 'Response Diff',
    description: 'Shared line/JSON diff used by the API client and Proxy to compare two responses.',
  },
  // No registerMain: pure library.
};

export default plugin;
