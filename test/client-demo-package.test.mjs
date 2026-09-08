// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { buildDemoArchive, crc32, DEMO_FILES } from '../scripts/package-client-demo.mjs';

const source = fileURLToPath(new URL('../examples/node-client/', import.meta.url));
async function copyFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'perpay-demo-package-'));
  t.after(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('perpay-demo-package-')) throw new Error('unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of DEMO_FILES) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await copyFile(join(source, name), join(directory, name));
  }
  return directory;
}
function entries(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 10), DEMO_FILES.length);
  const result = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < DEMO_FILES.length; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    assert.equal(buffer.readUInt16LE(offset + 10), 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(offset + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const bytes = inflateRawSync(buffer.subarray(start, start + buffer.readUInt32LE(offset + 20)));
    assert.equal(crc32(bytes), buffer.readUInt32LE(offset + 16));
    assert.equal(bytes.length, buffer.readUInt32LE(offset + 24));
    assert.equal(result.has(name), false);
    result.set(name, bytes);
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return result;
}

describe('caller demo distribution', () => {
  it('uses the standard ZIP CRC32 polynomial', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });
  it('produces a reproducible archive with every whitelisted file byte-identical', async () => {
    const archive = await buildDemoArchive();
    assert.deepEqual(archive, await buildDemoArchive());
    const content = entries(archive);
    assert.deepEqual([...content.keys()], DEMO_FILES.map(name => 'perpay-client-demo/' + name));
    for (const name of DEMO_FILES) assert.deepEqual(content.get('perpay-client-demo/' + name), await readFile(join(source, name)));
    assert.equal(JSON.parse(content.get('perpay-client-demo/package.json').toString()).dependencies, undefined);
  });
  it('never includes local environment files, databases, logs or private keys', async t => {
    const directory = await copyFixture(t);
    await mkdir(join(directory, 'data'));
    for (const name of ['.env', '.env.local', 'application-private.pem', 'demo.log', 'data/demo.sqlite3']) await writeFile(join(directory, name), 'synthetic-sensitive-do-not-package');
    const content = entries(await buildDemoArchive(directory));
    assert.equal([...content.values()].some(bytes => bytes.includes('synthetic-sensitive-do-not-package')), false);
    assert.equal(content.size, DEMO_FILES.length);
  });
  it('refuses a filled-in secret in the supposedly safe environment template', async t => {
    const directory = await copyFixture(t);
    const file = join(directory, '.env.example');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('PERPAY_API_SECRET=', 'PERPAY_API_SECRET=synthetic-do-not-package'));
    await assert.rejects(buildDemoArchive(directory), /Refusing to package/);
  });
});
