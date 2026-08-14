// Example: 4173, unless PLAYWRIGHT_PORT overrides the smoke-test server port.
const requestedPort = Number(process.env.PLAYWRIGHT_PORT || 4173);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4173;
const WORKERS = Number(process.env.PLAYWRIGHT_WORKERS || 1);

// Example: http://127.0.0.1:4173, or an externally managed server URL.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.PYTHON || 'node scripts/run_python.mjs';

import { defineConfig, devices } from '@playwright/test';

// Shape: Playwright config for the no-bundler static viewer smoke tests.
const config = {
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
};

config.workers = WORKERS;

if (!process.env.PLAYWRIGHT_BASE_URL) {
  config.webServer = {
    command: `${PYTHON} python/serve.py --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Cold-starting node -> python -> http on a loaded machine or CI runner can
    // take well past a tight 15s window; match Playwright's own 60s default so a
    // slow boot does not fail the suite before any test runs.
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  };
}

export default defineConfig(config);
