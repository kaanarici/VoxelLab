import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadConfigInFreshRuntime({
  href,
  localConfig = null,
  publicConfig = null,
  localTokenStatus = 200,
  localToken = 'runtime-local-token',
}) {
  const script = `
    globalThis.location = new URL(${JSON.stringify(href)});
    const calls = [];
    const localConfig = ${JSON.stringify(localConfig)};
    const publicConfig = ${JSON.stringify(publicConfig)};
    const localTokenStatus = ${JSON.stringify(localTokenStatus)};
    const localToken = ${JSON.stringify(localToken)};
    globalThis.fetch = async (url) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith('/config.local.json') || value === './config.local.json') {
        return localConfig ? Response.json(localConfig) : new Response('', { status: 404 });
      }
      if (value.endsWith('/config.json') || value === './config.json') {
        return publicConfig ? Response.json(publicConfig) : new Response('', { status: 404 });
      }
      if (value.endsWith('/api/local-token')) {
        if (localTokenStatus !== 200) return new Response('', { status: localTokenStatus });
        return Response.json({ localApiToken: localToken });
      }
      throw new Error('unexpected fetch ' + value);
    };
    const { loadConfig } = await import('./js/config.js');
    const config = await loadConfig();
    console.log(JSON.stringify({
      calls,
      siteName: config.siteName,
      localApiToken: config.localApiToken || '',
      localAiAvailable: config.localAiAvailable,
      aiReady: config.ai?.ready,
      aiIssues: config.ai?.issues || [],
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
  });
  return JSON.parse(stdout);
}

test('loadConfig prefers config.json on hosted origins without probing config.local.json first', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'https://viewer.example/',
    localConfig: { siteName: 'Local Override' },
    publicConfig: { siteName: 'Hosted Config' },
  });

  assert.deepEqual(result.calls, ['./config.json']);
  assert.equal(result.siteName, 'Hosted Config');
  assert.equal(result.localApiToken, '');
  assert.equal(result.localAiAvailable, true);
});

test('loadConfig preserves config.local.json priority on local backend origins', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'http://127.0.0.1:8000/',
    localConfig: { siteName: 'Local Override' },
    publicConfig: { siteName: 'Hosted Config' },
  });

  assert.deepEqual(result.calls, ['/api/local-token', './config.local.json']);
  assert.equal(result.siteName, 'Local Override');
  assert.equal(result.localApiToken, 'runtime-local-token');
  assert.equal(result.localAiAvailable, true);
});

test('loadConfig disables local AI actions when localhost has no helper token route', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'http://127.0.0.1:4173/',
    publicConfig: { siteName: 'Static Local Config' },
    localTokenStatus: 404,
  });

  assert.deepEqual(result.calls, ['/api/local-token', './config.local.json', './config.json']);
  assert.equal(result.siteName, 'Static Local Config');
  assert.equal(result.localApiToken, '');
  assert.equal(result.localAiAvailable, false);
  assert.equal(result.aiReady, false);
  assert.deepEqual(result.aiIssues, ['Local helper API is unavailable. Run npm start for local AI actions.']);
});
