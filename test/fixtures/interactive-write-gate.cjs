// Test-only preload: inject a one-shot failure or pause into auth-file staging.
// The application has no test hooks and never loads this module in production.
const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { readFile, unlink, writeFile } = fs;

fs.writeFile = async (file, contents, options) => {
  const marker = process.env.INTERACTIVE_TEST_WRITE_GATE;
  const prefix = `${join(process.env.DATA_DIR || '', 'auth.json')}.`;
  if (marker && String(file).startsWith(prefix)) {
    const command = await readFile(marker, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (command === 'fail') {
      await unlink(marker);
      throw Object.assign(new Error('Simulated session staging failure'), { code: 'EIO' });
    }
    if (command === 'pause') {
      await writeFile(`${marker}.entered`, 'staging', 'utf8');
      const deadline = Date.now() + 10_000;
      while (await fs.stat(marker).then(() => true, () => false)) {
        if (Date.now() >= deadline) throw new Error('Test staging gate was not released');
        await delay(10);
      }
    }
  }
  return writeFile(file, contents, options);
};
syncBuiltinESMExports();
