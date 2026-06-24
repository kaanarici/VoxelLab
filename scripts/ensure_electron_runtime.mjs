import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch (error) {
  throw new Error(`Electron runtime is not installed correctly: ${error.message}`);
}

if (typeof electronPath !== 'string' || !existsSync(electronPath) || !statSync(electronPath).isFile()) {
  throw new Error(`Electron runtime path is missing or invalid: ${electronPath || '(empty)'}`);
}

console.log(`Electron runtime ready: ${electronPath}`);
