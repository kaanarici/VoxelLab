#!/usr/bin/env node
/* global console, process */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOC = path.join(ROOT, 'ARCHITECTURE.md');
const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.py']);
const LOCAL_PATH_PREFIX = /^(?:js|python|scripts|tests)\//;
const EXTERNAL_OR_ANCHOR = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayDocPath(docPath) {
  const relative = path.relative(ROOT, docPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return path.basename(docPath);
}

function stripFencedCode(markdown) {
  return markdown.replace(/^```[\s\S]*?^```/gm, '');
}

function cleanLinkTarget(target) {
  let clean = target.trim();
  if (clean.startsWith('<') && clean.endsWith('>')) {
    clean = clean.slice(1, -1);
  }
  if (EXTERNAL_OR_ANCHOR.test(clean)) {
    return '';
  }
  clean = clean.split('#')[0].split('?')[0].replace(/^\.\//, '');
  if (path.isAbsolute(clean) || clean.startsWith('../')) {
    return '';
  }
  return clean;
}

function isCodePath(candidate) {
  return Boolean(candidate) && CODE_EXTENSIONS.has(path.extname(candidate)) && !candidate.includes('*');
}

function addLinkPaths(markdown, paths) {
  const linkTarget = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(linkTarget)) {
    const target = cleanLinkTarget(match[1]);
    if (isCodePath(target)) {
      paths.add(target);
    }
  }
}

function addLocalPathTokens(markdown, paths) {
  const scanText = stripFencedCode(markdown);
  const token = /(^|[^A-Za-z0-9_./-])((?:js|python|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|py))(?![A-Za-z0-9_.-])/g;
  for (const match of scanText.matchAll(token)) {
    const candidate = match[2];
    if (LOCAL_PATH_PREFIX.test(candidate) && isCodePath(candidate)) {
      paths.add(candidate);
    }
  }
}

function collectArchitecturePaths(markdown) {
  const paths = new Set();
  addLinkPaths(markdown, paths);
  addLocalPathTokens(markdown, paths);
  return [...paths].sort((a, b) => a.localeCompare(b, 'en'));
}

function collectBarePythonModules(markdown) {
  const names = readdirSync(path.join(ROOT, 'python'))
    .filter((name) => name.endsWith('.py'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const misses = new Set();

  for (const name of names) {
    const bareModule = new RegExp(`(^|[^A-Za-z0-9_./-])(${escapeRegExp(name)})\\b`, 'gm');
    if (bareModule.test(markdown)) {
      misses.add(name);
    }
  }

  return [...misses];
}

function main() {
  const docPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : DEFAULT_DOC;
  const markdown = readFileSync(docPath, 'utf8');
  const paths = collectArchitecturePaths(markdown);
  const missing = paths.filter((relPath) => !existsSync(path.join(ROOT, relPath)));
  const barePython = collectBarePythonModules(markdown);

  for (const relPath of missing) {
    console.error(`missing: ${relPath}`);
  }
  for (const name of barePython) {
    console.error(`bare python module: ${name} (use python/${name})`);
  }

  if (missing.length > 0 || barePython.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`all ${paths.length} ${displayDocPath(docPath)} paths exist`);
}

main();
