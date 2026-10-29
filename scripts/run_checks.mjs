import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const scripts = process.argv.slice(2);
if (!scripts.length) {
  console.error('usage: node scripts/run_checks.mjs <npm-script>...');
  process.exit(2);
}

const limit = Math.max(1, Math.min(scripts.length, Number(process.env.CHECK_CONCURRENCY) || Math.ceil(availableParallelism() / 3)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const started = Date.now();
const failures = [];
const queue = [...scripts];

function run(script) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(npm, ['run', '-s', script], { env: process.env, shell: process.platform === 'win32' });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`ok    ${script} (${seconds}s)`);
      } else {
        failures.push(script);
        console.log(`FAIL  ${script} (${seconds}s)\n${output.trimEnd()}\n`);
      }
      resolve();
    });
  });
}

async function worker() {
  while (queue.length) await run(queue.shift());
}

await Promise.all(Array.from({ length: limit }, worker));
const total = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.log(`\n${failures.length} of ${scripts.length} checks failed in ${total}s: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${scripts.length} checks passed in ${total}s`);
