import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const REPO_ROOT = new URL('../../../', import.meta.url);

const STATIC_SPECIFIER = /(?:^|\n)\s*(?:import|export)(?:[\s\S]*?)\sfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function repoPath(relativePath) {
  return fileURLToPath(new URL(relativePath, REPO_ROOT));
}

export function moduleSource(relativePath) {
  return readFileSync(repoPath(relativePath), 'utf8');
}

function collect(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]);
}

export function importSpecifiers(relativePath) {
  const source = moduleSource(relativePath);
  return {
    static: [...new Set([...collect(source, STATIC_SPECIFIER), ...collect(source, BARE_IMPORT)])],
    dynamic: [...new Set(collect(source, DYNAMIC_IMPORT))],
  };
}

export function resolvedDependencies(relativePath) {
  const base = new URL(relativePath, REPO_ROOT);
  const { static: staticSpecifiers, dynamic } = importSpecifiers(relativePath);
  const resolve = specifier => (
    specifier.startsWith('.')
      ? new URL(specifier, base).href.slice(REPO_ROOT.href.length)
      : specifier
  );
  return {
    static: staticSpecifiers.map(resolve),
    dynamic: dynamic.map(resolve),
    all: [...new Set([...staticSpecifiers, ...dynamic].map(resolve))],
  };
}

export function moduleExists(relativePath) {
  return existsSync(repoPath(relativePath));
}
