import dotenv from 'dotenv';
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInteractiveLoginConfig } from '../lib/interactive-login.js';

/**
 * Deployment gate for `npm run check:prod`.
 *
 * Loads .env, verifies the production environment, syntax-checks every project
 * JavaScript file, runs the test suite, and only then starts the server.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

const SKIP_DIRS = new Set([
  '.git',
  '.nyc_output',
  '.playwright',
  '.playwright-cli',
  'blob-report',
  'coverage',
  'node_modules',
  'playwright-report',
  'sessions',
  'test-results',
  'tmp',
]);

function fail(message) {
  console.error(`\n[check:prod] ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await javascriptFiles(join(directory, entry.name))));
    } else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

if (process.env.NODE_ENV !== 'production') {
  fail(
    'NODE_ENV must be set to "production" before deployment.\n' +
      'Set it in .env or in the environment, then run: npm run check:prod',
  );
}

const INSECURE_SESSION_SECRETS = new Set([
  'dev-secret-change-in-production',
  'change-me',
  'changeme',
  'your-session-secret',
  'replace-with-at-least-32-random-characters',
]);
const INSECURE_HARVEST_TOKENS = new Set([
  'change-me',
  'changeme',
  'harvest-token',
  'replace-with-at-least-32-random-characters',
]);
const sessionSecret = String(process.env.SESSION_SECRET ?? '');
if (sessionSecret.length < 32 || INSECURE_SESSION_SECRETS.has(sessionSecret.toLowerCase())) {
  fail(
    'SESSION_SECRET must be set to a unique value of at least 32 characters.\n' +
      'Replace the placeholder and generate one with:\n' +
      'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  );
}

const browserbaseApiKey = String(process.env.BROWSERBASE_API_KEY ?? '').trim();
if (process.env.INTERACTIVE_LOGIN_ENABLED !== 'true' && (!browserbaseApiKey || browserbaseApiKey === 'YOUR_API_KEY')) {
  fail(
    'BROWSERBASE_API_KEY must be set to a real Browserbase API key.\n' +
      'Get it from https://www.browserbase.com/settings and keep it out of source control.',
  );
}

const harvestApiToken = String(process.env.HARVEST_API_TOKEN ?? '').trim();
if (harvestApiToken.length < 32 || INSECURE_HARVEST_TOKENS.has(harvestApiToken.toLowerCase())) {
  fail(
    'HARVEST_API_TOKEN must be set to a unique value of at least 32 characters in production.\n' +
      'This is the bearer token used by trusted backends to call POST /api/harvest-token.\n' +
      'Generate one with:\n' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
}

if (process.env.INTERACTIVE_LOGIN_ENABLED === 'true') {
  try {
    resolveInteractiveLoginConfig();
  } catch (error) {
    fail(error.message);
  }
}

console.log('[check:prod] Environment verified (NODE_ENV=production).');

const files = (await javascriptFiles(ROOT))
  .map((file) => relative(ROOT, file))
  .sort();

console.log(`[check:prod] Syntax-checking ${files.length} JavaScript file(s)...`);
for (const file of files) {
  if (run(process.execPath, ['--check', file]) !== 0) {
    fail(`Syntax check failed: ${file}`);
  }
}

console.log('[check:prod] Running the test suite...');
if (run(process.execPath, ['--test', 'test/*.test.js'], { env: { ...process.env, NODE_ENV: 'test' } }) !== 0) {
  fail('The test suite failed; the server was not started.');
}

console.log('[check:prod] Tests passed. Starting server.js...');
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
});

server.once('error', (error) => {
  fail(`Could not start server.js: ${error.message}`);
});
server.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[check:prod] Server stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
