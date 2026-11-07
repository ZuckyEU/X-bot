// Credential-free runner fixture: record the staged session, then wait for release.
const { readFile, stat, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const unconfirmedReplyState = process.env.SESSION_TEST_UNCONFIRMED_REPLY_STATE;
  const failedUrl = process.env.SESSION_TEST_UNCONFIRMED_REPLY_URL;
  if (unconfirmedReplyState && (!failedUrl || failedUrl === process.argv[2])) {
    const priorAttempts = Number(await readFile(unconfirmedReplyState, 'utf8').catch(() => '0')) || 0;
    await writeFile(unconfirmedReplyState, String(priorAttempts + 1), 'utf8');
    if (priorAttempts === 1) {
      console.error('Failed: Reply verification failed: Post was not confirmed on X');
      process.exitCode = 1;
    } else {
      // Exercise legacy warnings on both streams, including an unterminated
      // stdout line and a zero exit code on the last failed attempt.
      const warning = 'Warning: could not confirm the reply was sent — check the browser.';
      if (priorAttempts === 0) process.stdout.write(warning);
      else console.warn(warning);
    }
    return;
  }

  const retryState = process.env.SESSION_TEST_RETRY_STATE;
  if (retryState) {
    const priorAttempts = Number(await readFile(retryState, 'utf8').catch(() => '0')) || 0;
    await writeFile(retryState, String(priorAttempts + 1), 'utf8');
    if (priorAttempts === 0) {
      console.error('Failed: page.goto: net::ERR_CONNECTION_RESET');
      process.exitCode = 1;
      return;
    }
  }

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
