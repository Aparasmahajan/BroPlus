// Make the test videos offline-server.mjs serves (the recipe from README.md → "Offline", as a script).
//   node make-offline-media.mjs <ffmpeg.exe> <media-folder>
// Skips files that already exist, so re-running is cheap.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export function makeOfflineMedia(F, M) {
  mkdirSync(M, { recursive: true });
  // cwd = the output folder: ffmpeg writes an fMP4 HLS init segment (init.mp4) relative to its cwd.
  const ff = (out, args) => { if (!existsSync(out)) execFileSync(F, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', cwd: dirname(out) }); };
  const lavfi = (src, freq, secs) => ['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=frequency=${freq}`, '-t', String(secs)];

  ff(join(M, 'clip.mp4'), [...lavfi('testsrc=size=640x360:rate=25', 440, 10), '-c:v', 'libx264', '-b:v', '1M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(M, 'clip.mp4')]);
  for (const i of [2, 3]) ff(join(M, `clip${i}.mp4`), [...lavfi('testsrc2=size=640x360:rate=25', 300 * i, 5 + i), '-c:v', 'libx264', '-b:v', '1M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(M, `clip${i}.mp4`)]);
  ff(join(M, 'clip.avi'), [...lavfi('testsrc=size=640x360:rate=25', 440, 10), '-c:v', 'mpeg4', '-b:v', '1M', '-c:a', 'libmp3lame', join(M, 'clip.avi')]);
  ff(join(M, 'slow.mp4'), [...lavfi('testsrc=size=640x360:rate=25', 660, 20), '-c:v', 'libx264', '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(M, 'slow.mp4')]);

  // "Bot wall" HLS: needs the page's cookie, refuses Sec-Fetch-Mode: navigate like download tools send.
  const G = join(M, 'guard');
  for (const d of ['v360', 'v720', 'audio', 'drm', 'file']) mkdirSync(join(G, d), { recursive: true });
  if (!existsSync(join(G, 'file', 'clip.mp4'))) copyFileSync(join(M, 'clip.mp4'), join(G, 'file', 'clip.mp4'));
  ff(join(G, 'src.mp4'), [...lavfi('testsrc=size=1280x720:rate=25', 500, 12), '-c:v', 'libx264', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(G, 'src.mp4')]);
  if (!existsSync(join(G, 'v360', 'index.m3u8'))) {
    writeFileSync(join(G, 'v360', 'key.bin'), randomBytes(16));
    writeFileSync(join(G, 'keyinfo'), `key.bin\n${join(G, 'v360', 'key.bin')}\n`);
  }
  ff(join(G, 'v360', 'index.m3u8'), ['-i', join(G, 'src.mp4'), '-vf', 'scale=-2:360', '-c:v', 'libx264', '-b:v', '600k', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', join(G, 'keyinfo'), '-hls_segment_filename', join(G, 'v360', 's%03d.ts'), join(G, 'v360', 'index.m3u8')]);
  ff(join(G, 'v720', 'init.mp4'), ['-i', join(G, 'src.mp4'), '-an', '-c:v', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(G, 'v720', 's%03d.m4s'), join(G, 'v720', 'index.m3u8')]);
  ff(join(G, 'audio', 'init.mp4'), ['-i', join(G, 'src.mp4'), '-vn', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(G, 'audio', 's%03d.m4s'), join(G, 'audio', 'index.m3u8')]);
  writeFileSync(join(G, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nv360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"\nv720/index.m3u8\n');
  writeFileSync(join(G, 'drm', 'index.m3u8'), '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm-key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2.0,\n../v360/s000.ts\n#EXT-X-ENDLIST\n');
}

if (process.argv[1]?.endsWith('make-offline-media.mjs')) {
  const [, , F, M] = process.argv;
  if (!F || !M) throw new Error('usage: node make-offline-media.mjs <ffmpeg> <media-folder>');
  makeOfflineMedia(F, M);
  console.log('media ready in', M);
}
