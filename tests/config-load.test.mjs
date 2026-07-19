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
  desktopSettings = null,
}) {
  const script = `
    globalThis.location = new URL(${JSON.stringify(href)});
    const calls = [];
    const localConfig = ${JSON.stringify(localConfig)};
    const publicConfig = ${JSON.stringify(publicConfig)};
    const localTokenStatus = ${JSON.stringify(localTokenStatus)};
    const localToken = ${JSON.stringify(localToken)};
    const desktopSettings = ${JSON.stringify(desktopSettings)};
    if (desktopSettings !== null) {
      globalThis.voxellabDesktop = { getCloudSettings: async () => desktopSettings };
    }
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
    const { loadConfig, viewerAiFlags } = await import('./js/config.js');
    const config = await loadConfig();
    const aiFlags = viewerAiFlags();
    console.log(JSON.stringify({
      calls,
      siteName: config.siteName,
      localApiToken: config.localApiToken || '',
      localAiAvailable: config.localAiAvailable,
      localAiActionsEnabled: aiFlags.localAiActionsEnabled,
      aiReady: config.ai?.ready,
      aiIssues: config.ai?.issues || [],
      modalWebhookBase: config.modalWebhookBase,
      r2PublicUrl: config.r2PublicUrl,
      trustedUploadOrigins: config.trustedUploadOrigins,
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

test('loadConfig maps desktop cloud credentials to the local desktop proxy', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'voxellab://app/index.html',
    publicConfig: { modalWebhookBase: '', r2PublicUrl: '' },
    localTokenStatus: 404,
    desktopSettings: {
      modalWebhookBase: 'https://example-org--medical-imaging-pipeline.modal.run',
      r2PublicUrl: 'https://pub.example.r2.dev',
      trustedUploadOrigins: ['https://pub.example.r2.dev'],
      hasModalAuthToken: true,
      cloudProcessing: true,
    },
  });

  assert.deepEqual(result.calls, ['/api/local-token', './config.local.json', './config.json']);
  assert.equal(result.modalWebhookBase, '/api/cloud');
  assert.equal(result.r2PublicUrl, 'https://pub.example.r2.dev');
  assert.deepEqual(result.trustedUploadOrigins, ['https://pub.example.r2.dev']);
});

test('loadConfig does not activate the desktop cloud proxy when processing is disabled', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'voxellab://app/index.html',
    publicConfig: { modalWebhookBase: '', r2PublicUrl: '' },
    localTokenStatus: 404,
    desktopSettings: {
      modalWebhookBase: 'https://example-org--medical-imaging-pipeline.modal.run',
      r2PublicUrl: 'https://pub.example.r2.dev',
      trustedUploadOrigins: ['https://pub.example.r2.dev'],
      hasModalAuthToken: true,
      cloudProcessing: false,
    },
  });

  assert.equal(result.modalWebhookBase, '');
  assert.equal(result.r2PublicUrl, 'https://pub.example.r2.dev');
});

test('loadConfig enables desktop AI actions when the local helper token is available', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'voxellab://app/index.html',
    localConfig: { features: { aiAnalysis: true } },
    publicConfig: { features: { aiAnalysis: false } },
    desktopSettings: {},
  });

  assert.deepEqual(result.calls, ['/api/local-token', './config.local.json']);
  assert.equal(result.localApiToken, 'runtime-local-token');
  assert.equal(result.localAiAvailable, true);
  assert.equal(result.localAiActionsEnabled, true);
});

test('loadConfig preserves config.local.json priority on local backend origins', async () => {
  const result = await loadConfigInFreshRuntime({
    href: 'http://127.0.0.1:8000/',
    localConfig: { siteName: 'Local Override', features: { aiAnalysis: true } },
    publicConfig: { siteName: 'Hosted Config' },
  });

  assert.deepEqual(result.calls, ['/api/local-token', './config.local.json']);
  assert.equal(result.siteName, 'Local Override');
  assert.equal(result.localApiToken, 'runtime-local-token');
  assert.equal(result.localAiAvailable, true);
  assert.equal(result.localAiActionsEnabled, true);
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
