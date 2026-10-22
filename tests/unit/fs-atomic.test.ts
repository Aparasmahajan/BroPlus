// Unit tests for the crash-safe writer behind JsonStore.
// Run with: node --test tests/unit/   (Node 24 runs .ts directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../../src/main/fs-atomic.ts';

/** A fresh empty scratch dir for one test; cleaned up at the end. */
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-atomic-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tmpFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

test('writes a new file with the exact content', () => {
  withDir((dir) => {
    const file = join(dir, 'data.json');
    writeFileAtomicSync(file, '{"a":1}');
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  });
});

test('replaces an existing file wholesale', () => {
  withDir((dir) => {
    const file = join(dir, 'data.json');
    writeFileSync(file, '{"old":true}');
    writeFileAtomicSync(file, '{"new":true}');
    assert.equal(readFileSync(file, 'utf8'), '{"new":true}');
  });
});

test('leaves no temp file behind on success', () => {
  withDir((dir) => {
    const file = join(dir, 'data.json');
    writeFileAtomicSync(file, 'x');
    writeFileAtomicSync(file, 'y');
    assert.deepEqual(tmpFiles(dir), []);
  });
});

test('round-trips binary content byte-for-byte', () => {
  withDir((dir) => {
    const file = join(dir, 'blob.bin');
    const bytes = Uint8Array.from([0, 1, 2, 255, 128, 0, 42]);
    writeFileAtomicSync(file, bytes);
    assert.deepEqual(new Uint8Array(readFileSync(file)), bytes);
  });
});

test('on failure it throws, writes no target, and leaves no temp file', () => {
  withDir((dir) => {
    // A path inside a directory that does not exist can't be written: the temp
    // write fails before any rename, so the destination is never created.
    const missing = join(dir, 'no-such-subdir', 'data.json');
    assert.throws(() => writeFileAtomicSync(missing, 'should not land'));
    assert.deepEqual(tmpFiles(dir), []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('a failed write leaves a pre-existing file intact', () => {
  withDir((dir) => {
    const file = join(dir, 'data.json');
    writeFileAtomicSync(file, '{"keep":true}');
    // A failing write elsewhere in the same dir must not disturb this file.
    const missing = join(dir, 'gone', 'x.json');
    assert.throws(() => writeFileAtomicSync(missing, 'nope'));
    assert.equal(readFileSync(file, 'utf8'), '{"keep":true}');
  });
});
