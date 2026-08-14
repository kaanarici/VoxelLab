/* global console, process */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeReleaseChecksums(rootDir, outputPath) {
  const root = path.resolve(rootDir);
  const output = path.resolve(outputPath);
  assert.ok(existsSync(root), `release asset root does not exist: ${root}`);
  const files = walkFiles(root).filter(file => path.resolve(file) !== output);
  assert.ok(files.length > 0, `${root} contains no release assets`);
  const names = files.map(file => path.basename(file));
  assert.equal(new Set(names).size, names.length, 'release asset basenames must be unique');
  const lines = [];
  for (const file of files) lines.push(`${await sha256(file)}  ${path.basename(file)}`);
  writeFileSync(output, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o644 });
  return { output, fileCount: files.length, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] || 'release-assets';
  const output = process.argv[3] || path.join(root, 'SHA256SUMS');
  const result = await writeReleaseChecksums(root, output);
  console.log(`OK: wrote SHA-256 checksums for ${result.fileCount} release assets`);
}
