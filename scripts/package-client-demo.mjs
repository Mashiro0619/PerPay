// SPDX-License-Identifier: MIT
// Reproducible ZIP32 archive using only Node built-ins; never enumerate a user's data.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const project = fileURLToPath(new URL('../', import.meta.url));
export const DEMO_FILES = Object.freeze([
  '.env.example', '.gitignore', 'LICENSE', 'README.md', 'package.json',
  'perpay.mjs', 'server.mjs', 'store.mjs',
  'public/app.js', 'public/index.html', 'public/style.css', 'test/demo.test.mjs',
].sort());
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export async function buildDemoArchive(sourceDirectory = join(project, 'examples', 'node-client')) {
  const source = await realpath(sourceDirectory);
  const local = [], central = [];
  let offset = 0;
  for (const relative of DEMO_FILES) {
    const file = resolve(source, relative);
    const metadata = await lstat(file);
    const actual = await realpath(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !actual.startsWith(source + sep)) throw new Error('Demo source must be a regular file within the example directory: ' + relative);
    if (metadata.size > 1024 * 1024) throw new Error('Unexpectedly large demo source: ' + relative);
    const bytes = await readFile(file);
    if (relative === '.env.example') {
      for (const key of ['PERPAY_API_SECRET', 'PERPAY_WEBHOOK_SECRET']) {
        const declarations = bytes.toString('utf8').split(/\r?\n/).filter(line => line.startsWith(key + '='));
        if (declarations.length !== 1 || declarations[0] !== key + '=') throw new Error('Refusing to package a non-empty or ambiguous secret in .env.example.');
      }
    }
    const name = Buffer.from('perpay-client-demo/' + relative, 'utf8');
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12); // 1980-01-01, 00:00:00. No source timestamps.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(0x81a40000, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(DEMO_FILES.length, 8); end.writeUInt16LE(DEMO_FILES.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packageDemo(output = join(project, 'dist', 'demo.zip')) {
  const archive = await buildDemoArchive();
  await mkdir(dirname(output), { recursive: true });
  const temporary = output + '.tmp-' + randomUUID();
  try {
    await writeFile(temporary, archive, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { output, files: DEMO_FILES.length, bytes: archive.length };
}

if (import.meta.main) {
  const result = await packageDemo();
  console.log('Created ' + result.output + ' (' + result.files + ' files, ' + result.bytes + ' bytes).');
}
