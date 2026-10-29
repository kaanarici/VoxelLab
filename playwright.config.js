import { availableParallelism } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

const requestedPort = Number(process.env.PLAYWRIGHT_PORT || 4173);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4173;
const WORKERS = Number(process.env.PLAYWRIGHT_WORKERS) || Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)));

const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.PYTHON || 'node scripts/run_python.mjs';


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

    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  };
}

export default defineConfig(config);
