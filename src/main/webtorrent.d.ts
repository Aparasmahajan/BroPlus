// webtorrent ships no types; torrents.ts describes the parts Bro uses.
declare module 'webtorrent' {
  const WebTorrent: new (opts?: Record<string, unknown>) => unknown;
  export default WebTorrent;
}
