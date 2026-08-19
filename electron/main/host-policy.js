import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/host-policy.json'), 'utf8'));

export const ROOT_FILES = new Set(POLICY.staticRootFiles);
export const ROOT_DIRS = POLICY.staticRootDirectories;
export const PACKAGE_PATHS = POLICY.staticPackagePaths;

export function contentSecurityPolicy(variant = 'desktop') {
  return [...POLICY.csp.shared, ...POLICY.csp[variant]].join('; ');
}
