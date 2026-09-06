#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDocumentPaths } from './check_architecture_paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ACTIVE_DOCS = Object.freeze([
  'ACCURACY_LEDGER.md',
  'ARCHITECTURE.md',
  'BUILDING_WITH_AI.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'DESIGN.md',
  'R2_SETUP.md',
  'README.md',
  'SECURITY.md',
  'tests/fixtures/zarr/SOURCE.md',
]);
const PRIVATE_ACTIVE_DOCS = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'FLOW_INDEX.md',
  'MISSION.md',
  'docs/roadmap.md',
  'docs/validation-matrix.md',
]);
const FLOW_DOCS = Object.freeze([
  '.flow.yaml',
  '.flow/root.yaml',
  '.flow/registry.yaml',
  'electron/.flow.yaml',
  'js/.flow.yaml',
  'scripts/.flow.yaml',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.playwright-mcp',
  '.pytest_cache',
  '.venv',
  'data_compressed',
  'demo_sources',
  'node_modules',
  'out',
  'synthseg_repo',
  'test-results',
]);
const EXTERNAL_OR_ANCHOR = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const HISTORICAL_PREFIXES = Object.freeze(['docs/plans/', 'docs/reviews/', 'plans/']);
const HISTORICAL_FILES = new Set(['docs/frontend-cleanup-plan.md']);

function normalizedRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function walkMarkdown(rootDir = ROOT) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

export function isHistoricalDocument(relativePath) {
  return HISTORICAL_FILES.has(relativePath)
    || HISTORICAL_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

function cleanMarkdownTarget(rawTarget) {
  let target = String(rawTarget || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (!target || EXTERNAL_OR_ANCHOR.test(target)) return '';
  target = target.split('#')[0].split('?')[0];
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function markdownLinkTargets(markdown) {
  const targets = [];
  const link = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(link)) {
    const target = cleanMarkdownTarget(match[1]);
    if (target) targets.push(target);
  }
  return targets;
}

export function referencedNpmScripts(markdown) {
  return [...new Set([...markdown.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)].map(match => match[1]))]
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function checkActiveDocument(relativePath, packageScripts, errors) {
  const filePath = path.join(ROOT, relativePath);
  const markdown = readFileSync(filePath, 'utf8');
  if (relativePath !== 'AGENTS.md' && /\/Users\/[A-Za-z0-9._-]+\//.test(markdown)) {
    errors.push(`${relativePath}: current documentation must not contain an absolute user path`);
  }
  for (const target of markdownLinkTargets(markdown)) {
    if (path.isAbsolute(target)) {
      errors.push(`${relativePath}: local link must be relative: ${target}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== ROOT) {
      errors.push(`${relativePath}: local link escapes the repository: ${target}`);
    } else if (!existsSync(resolved)) {
      errors.push(`${relativePath}: missing local link target: ${target}`);
    }
  }
  for (const scriptName of referencedNpmScripts(markdown)) {
    if (!Object.hasOwn(packageScripts, scriptName)) {
      errors.push(`${relativePath}: missing package.json script: npm run ${scriptName}`);
    }
  }
  const { barePython, missing } = checkDocumentPaths(filePath);
  for (const missingPath of missing) errors.push(`${relativePath}: missing code path: ${missingPath}`);
  for (const moduleName of barePython) {
    errors.push(`${relativePath}: bare Python module must use python/${moduleName}`);
  }
  if (/https:\/\/github\.com\/kaanarici\/VoxelLab\/releases\/tag\/v1\.(?:0\.0|1\.[01])/.test(markdown)) {
    errors.push(`${relativePath}: links a deleted release`);
  }
  if (/^## \[(?:1\.0\.0|1\.1\.[01])\]/m.test(markdown)) {
    errors.push(`${relativePath}: lists a deleted release as current history`);
  }
}

export function checkDocumentation() {
  const errors = [];
  const packageScripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const publicActive = PUBLIC_ACTIVE_DOCS.filter(relativePath => {
    if (!existsSync(path.join(ROOT, relativePath))) errors.push(`missing required public document: ${relativePath}`);
    return existsSync(path.join(ROOT, relativePath));
  });
  const privateActive = PRIVATE_ACTIVE_DOCS.filter(relativePath => existsSync(path.join(ROOT, relativePath)));
  const activeDocs = [...publicActive, ...privateActive];
  const knownActive = new Set([...PUBLIC_ACTIVE_DOCS, ...PRIVATE_ACTIVE_DOCS]);
  const markdownFiles = walkMarkdown().map(normalizedRelative);
  const historicalDocs = markdownFiles.filter(isHistoricalDocument);

  for (const relativePath of markdownFiles) {
    if (!knownActive.has(relativePath) && !isHistoricalDocument(relativePath)) {
      errors.push(`${relativePath}: documentation is not classified as current or historical`);
    }
  }
  for (const relativePath of historicalDocs) {
    const firstLines = readFileSync(path.join(ROOT, relativePath), 'utf8').split(/\r?\n/).slice(0, 30).join('\n');
    if (!/Documentation status: historical/i.test(firstLines)) {
      errors.push(`${relativePath}: historical document needs a status warning near the top`);
    }
  }
  for (const relativePath of activeDocs) checkActiveDocument(relativePath, packageScripts, errors);

  const flowDocs = FLOW_DOCS.filter(relativePath => existsSync(path.join(ROOT, relativePath)));
  for (const relativePath of flowDocs) {
    const { barePython, missing } = checkDocumentPaths(path.join(ROOT, relativePath));
    for (const missingPath of missing) errors.push(`${relativePath}: missing code path: ${missingPath}`);
    for (const moduleName of barePython) errors.push(`${relativePath}: bare Python module must use python/${moduleName}`);
  }

  if (errors.length) {
    throw new Error(`Documentation integrity failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
  return {
    activeDocs: activeDocs.length,
    flowDocs: flowDocs.length,
    historicalDocs: historicalDocs.length,
    markdownDocs: markdownFiles.length,
  };
}

function main() {
  const result = checkDocumentation();
  console.log(`OK: checked ${result.markdownDocs} Markdown documents (${result.activeDocs} current, ${result.historicalDocs} historical) and ${result.flowDocs} flow maps`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}
