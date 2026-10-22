// Pages with videos for offline-suite.mjs. Range requests supported (Chromium's player needs them).
//   node offline-server.mjs <port> <folder with clip.mp4 clip2.mp4 clip3.mp4 clip.avi slow.mp4>
//   (tests/e2e/README.md → "Offline" shows the ffmpeg commands that make them)
//   /video.html  plays clip.mp4 (H.264)      /avi.html  plays clip.avi (MPEG-4 Part 2 — Chromium can't)
//   /slow.html   plays slow.mp4 at ~64 KB/s  /plain.html  no video at all
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';

const [, , port = '8766', DIR] = process.argv;
if (!DIR) throw new Error('pass the media folder');

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Some lesson text that should be in the saved page.</p>${body}</body></html>`;
const pages = {
  '/video.html': page('Lesson One', '<video src="/clip.mp4" controls preload="auto" width="640"></video>'),
  '/avi.html': page('Old Format Lesson', '<video src="/clip.avi" controls preload="auto" width="640"></video><a href="/clip.avi">clip.avi</a>'),
  '/slow.html': page('Slow Lesson', '<video src="/slow.mp4" controls preload="auto" width="640"></video>'),
  '/plain.html': page('Just Text', '<p>No video here.</p>'),
  '/course.html': page('Three Lessons', ['clip.mp4', 'clip2.mp4', 'clip3.mp4'].map((v) => `<video src="/${v}" controls preload="metadata" width="320"></video>`).join('')),
};
// Pages behind a "bot wall": their media needs the cookie the page sets, and requests that
// look like a download tool (Sec-Fetch-Mode: navigate on a media file — yt-dlp sends that on
// everything) get 403. The page "plays" the stream with fetch(), like a JS player does.
const player = (src) => `<script>
  (async () => {
    const get = async (u) => (await fetch(u)).text();
    const master = await get(${JSON.stringify(src)});
    for (const line of master.split('\\n')) {
      const uri = line.startsWith('#') ? /URI="([^"]+)"/.exec(line)?.[1] : line.trim();
      if (uri) await get(new URL(uri, new URL(${JSON.stringify(src)}, location.href)).href);
    }
  })();
</script>`;
pages['/guarded.html'] = page('Guarded Lesson', player('/guard/master.m3u8'));
pages['/drm.html'] = page('Protected Lesson', player('/guard/drm/index.m3u8'));
pages['/guard-file.html'] = page('Guarded File', '<video src="/guard/file/clip.mp4" controls preload="auto" width="640"></video>');
const guardStats = { served: 0, blocked: 0 };

const types = {
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.bin': 'application/octet-stream',
};

/** ~rate bytes/s, in small slices. */
const throttle = (rate) =>
  new Transform({
    transform(chunk, _enc, cb) {
      const parts = [];
      for (let i = 0; i < chunk.length; i += 16384) parts.push(chunk.subarray(i, i + 16384));
      const next = () => {
        const p = parts.shift();
        if (!p) return cb();
        this.push(p);
        setTimeout(next, (p.length / rate) * 1000);
      };
      next();
    },
  });

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (pages[url.pathname]) {
    const cookie = url.pathname.startsWith('/guard') || url.pathname === '/drm.html' ? { 'set-cookie': 'bro_session=ok; Path=/' } : {};
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cookie });
    return res.end(pages[url.pathname]);
  }
  if (url.pathname === '/guard-stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(guardStats));
  }
  if (url.pathname.startsWith('/guard/')) {
    const allowed = /(^|;\s*)bro_session=ok/.test(req.headers.cookie ?? '') && req.headers['sec-fetch-mode'] !== 'navigate';
    if (!allowed) {
      guardStats.blocked++;
      res.writeHead(403);
      return res.end('Forbidden');
    }
    guardStats.served++;
  }
  const name = url.pathname.slice(1);
  const ext = name.slice(name.lastIndexOf('.'));
  if (!types[ext]) {
    res.writeHead(404);
    return res.end();
  }
  const file = join(DIR, name);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    res.writeHead(404);
    return res.end();
  }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  const headers = { 'content-type': types[ext], 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
  if (m) res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}` });
  else res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file, { start, end });
  (name.startsWith('slow') ? stream.pipe(throttle(64 * 1024)) : stream).pipe(res);
  res.on('close', () => stream.destroy());
}).listen(Number(port), '127.0.0.1', () => console.log(`offline fixtures on :${port}`));
