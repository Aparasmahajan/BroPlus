// Local download server for the download-manager tests.
//   node download-server.mjs [port]
// GET /file.bin       Range-capable (206), ETag; ?rate=<bytes/s per connection>&flaky=<n>&name=<file name>
//                     flaky=n → the first n data requests are cut off after 256 KB–2 MB
// GET /norange.bin    plain 200, ignores Range (forces Chromium's engine)
// POST /bump          the file "changes on the server" (new content + ETag)
// GET /stats          { requests, rangeRequests, maxConcurrent, current, version, sha256 }
// GET /reset-stats
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.argv[2] || 8765);
const SIZE = 40 * 1024 * 1024;
let version = 1;
let data = makeData(version);
let flakyServed = 0;
const stats = { requests: 0, rangeRequests: 0, maxConcurrent: 0, current: 0 };

function makeData(v) {
  // Deterministic, non-repeating bytes (so a misplaced segment changes the hash).
  const buf = Buffer.alloc(SIZE);
  let block = createHash('sha256').update(`bro-test-${v}`).digest();
  for (let off = 0; off < SIZE; off += block.length) {
    block.copy(buf, off);
    block = createHash('sha256').update(block).digest();
  }
  return buf;
}
const sha = () => createHash('sha256').update(data).digest('hex');
let digest = sha();

function send(res, req, body, { start, end, status, headers }) {
  const url = new URL(req.url, 'http://x');
  const rate = Number(url.searchParams.get('rate') || 0);
  const flaky = Number(url.searchParams.get('flaky') || 0);
  let cutAt = Infinity;
  if (flaky && flakyServed < flaky) {
    flakyServed++;
    cutAt = (256 + Math.floor(Math.random() * 1792)) * 1024;
  }
  res.writeHead(status, headers);
  stats.current++;
  stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.current);
  let pos = start;
  let sent = 0;
  const chunk = 64 * 1024;
  const done = () => {
    stats.current--;
  };
  res.on('close', done);
  const pump = () => {
    while (pos <= end) {
      if (sent >= cutAt) return req.socket.destroy(); // simulate a dropped connection
      const n = Math.min(chunk, end - pos + 1);
      const ok = res.write(body.subarray(pos, pos + n));
      pos += n;
      sent += n;
      if (rate) return setTimeout(pump, (n / rate) * 1000);
      if (!ok) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...stats, version, sha256: digest }));
    }
    if (url.pathname === '/reset-stats') {
      Object.assign(stats, { requests: 0, rangeRequests: 0, maxConcurrent: 0, current: stats.current });
      flakyServed = 0;
      return res.end('ok');
    }
    if (url.pathname === '/bump' && req.method === 'POST') {
      version++;
      data = makeData(version);
      digest = sha();
      return res.end(String(version));
    }
    const name = url.searchParams.get('name') || 'bro-test.bin';
    const base = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
    };
    if (url.pathname === '/norange.bin') {
      stats.requests++;
      return send(res, req, data, { start: 0, end: SIZE - 1, status: 200, headers: { ...base, 'content-length': SIZE } });
    }
    if (url.pathname === '/file.bin') {
      stats.requests++;
      const etag = `"v${version}"`;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (m) {
        stats.rangeRequests++;
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
        if (start >= SIZE || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${SIZE}` });
          return res.end();
        }
        return send(res, req, data, {
          start,
          end,
          status: 206,
          headers: { ...base, etag, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${SIZE}`, 'content-length': end - start + 1 },
        });
      }
      return send(res, req, data, {
        start: 0,
        end: SIZE - 1,
        status: 200,
        headers: { ...base, etag, 'accept-ranges': 'bytes', 'content-length': SIZE },
      });
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, '127.0.0.1', () => console.log(`download server on http://127.0.0.1:${PORT} (sha256 ${digest})`));
