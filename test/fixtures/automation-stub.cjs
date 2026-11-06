// Credential-free runner fixture: record the staged session, then wait for release.
const { readFile, stat, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const marker = process.env.SESSION_TEST_RUN_GATE;
  const state = JSON.parse(await readFile(process.env.AUTH_FILE_PATH, 'utf8'));
  await writeFile(`${marker}.entered`, JSON.stringify({
    username: process.env.X_ACCOUNT_USERNAME,
    state,
  }), { mode: 0o600 });
  const deadline = Date.now() + 10_000;
  while (await stat(marker).then(() => true, () => false)) {
    if (Date.now() >= deadline) throw new Error('Automation fixture was not released');
    await delay(10);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
