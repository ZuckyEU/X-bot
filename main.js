import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeBrowser,
  connectBrowser,
  getDefaultContext,
  getOrCreatePage,
  restoreStorageState,
  safeContextCall,
  safeGoto,
} from './lib/browser.js';
import { generateReply, MAX_REPLY_LENGTH, DEFAULT_TONE } from './lib/reply.js';

/**
 * X reply automation.
 *
 * Loads the session saved by `npm run auth`, opens a tweet, extracts its text,
 * asks Groq for a crypto "alpha" reply, posts it, then likes the tweet.
 *
 *   node main.js <tweet-url> [--dry-run] [--yes] [--headless] [--reply] [--like] [--repost] [--audit]
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR || ROOT);
const AUTH_FILE = process.env.AUTH_FILE_PATH || join(DATA_DIR, 'auth.json');
const TWEET_URL_PATTERN = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i;

const USAGE = `
Usage: node main.js <tweet-url> [options]

Options:
  --dry-run     Generate the reply but do not post or like
  --yes, -y     Skip the confirmation prompt
  --headless    Accepted for compatibility; Browserbase controls visibility
  --reply       Post the generated reply
  --like        Like the tweet after the reply is posted
  --repost      Repost the tweet after the reply is posted
  --audit       Audit mode — skip tweets already liked/replied to
  --reply-out=<path>   Write the generated reply text to a file (used by the server for history)
  --tone=<name>     Reply tone: analytical | casual-hype | brief-direct | technical-web3 (default: neutral)
  --help, -h    Show this help
`.trim();

const SEL = {
  tweet: 'article[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
  showMore: '[data-testid="tweet-text-show-more-link"]',
  reply: '[data-testid="reply"]',
  like: '[data-testid="like"]',
  unlike: '[data-testid="unlike"]',
  composer: '[data-testid="tweetTextarea_0"]',
  postButton: '[data-testid="tweetButton"]',
  toast: '[data-testid="toast"]',
};

/* ------------------------------- helpers -------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

function parseArgs(argv) {
  const options = {
    url: null,
    dryRun: false,
    yes: false,
    headless: false,
    reply: false,
    like: false,
    repost: false,
    audit: false,
    replyOut: null,
    tone: DEFAULT_TONE,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--reply') options.reply = true;
    else if (arg === '--like') options.like = true;
    else if (arg === '--repost') options.repost = true;
    else if (arg === '--no-reply') options.reply = false;
    else if (arg === '--no-like') options.like = false;
    else if (arg === '--no-repost') options.repost = false;
    else if (arg === '--audit') options.audit = true;
    else if (arg === '--no-audit') options.audit = false;
    else if (arg.startsWith('--reply-out=')) options.replyOut = arg.slice('--reply-out='.length);
    else if (arg.startsWith('--tone=')) options.tone = arg.slice('--tone='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
    else options.url = arg;
  }

  return options;
}

async function ask(question) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function waitUntilEnabled(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error('The post button never became enabled.');
}

/** Reads the session saved by auth.js (also accepts a bare cookie array). */
async function loadAuthState() {
  try {
    await access(AUTH_FILE);
  } catch {
    throw new Error('auth.json not found. Run `npm run auth` first to save your X session.');
  }

  const raw = (await readFile(AUTH_FILE, 'utf8')).replace(/^\uFEFF/, ''); // tolerate a BOM from Windows editors
  const parsed = JSON.parse(raw);
  const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;

  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('auth.json contains no cookies. Re-run `npm run auth`.');
  }

  const savedUsername = Array.isArray(parsed) ? null : parsed.username;
  const usernameMatch = String(savedUsername ?? '').trim().match(/^@?([A-Za-z0-9_]{1,15})$/);

  return {
    cookies,
    origins: Array.isArray(parsed) || !Array.isArray(parsed.origins) ? [] : parsed.origins,
    username: usernameMatch?.[1] ?? null,
  };
}

/* ------------------------------- X actions ------------------------------ */

async function ensureLoggedIn(page) {
  const navigation = await safeGoto(page, 'https://x.com/home', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  if (navigation.error) {
    console.warn(`[AUTH] Navigation warning: ${navigation.error.message}. Checking the session anyway…`);
  } else if (navigation.response && navigation.response.status() >= 400) {
    console.warn(`[AUTH] X returned HTTP ${navigation.response.status()} while opening the timeline.`);
  }

  try {
    await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    throw new Error('Not logged in — the session in auth.json is missing or expired. Run `npm run auth` again.');
  }
}

async function extractTweet(page) {
  const tweet = page.locator(SEL.tweet).first();
  await tweet.waitFor({ state: 'visible', timeout: 30_000 });

  const showMore = tweet.locator(SEL.showMore);
  if ((await showMore.count()) > 0) await showMore.first().click().catch(() => {});

  const text = (await tweet.locator(SEL.tweetText).first().innerText().catch(() => '')).trim();
  const header = (await tweet.locator(SEL.userName).first().innerText().catch(() => '')).trim();
  const author = header.match(/@([A-Za-z0-9_]+)/)?.[1] ?? 'unknown';

  if (!text) throw new Error('Could not read the tweet text (media-only post, or a login wall).');

  return { text, author };
}

async function postReply(page, reply) {
  const tweet = page.locator(SEL.tweet).first();
  await tweet.locator(SEL.reply).first().click();

  const replyBoxSelector = [
    '[role="dialog"] [data-testid="tweetTextarea_0"]',
    '[data-testid="tweetTextarea_0_label"]',
    'div[contenteditable="true"][aria-label*="Post text"]',
    'div[contenteditable="true"][role="textbox"]',
  ].join(', ');
  const dialogReplyBoxSelector = [
    '[role="dialog"] [data-testid="tweetTextarea_0"]',
    '[role="dialog"] [data-testid="tweetTextarea_0_label"]',
    '[role="dialog"] div[contenteditable="true"][aria-label*="Post text"]',
    '[role="dialog"] div[contenteditable="true"][role="textbox"]',
  ].join(', ');
  const replyBoxDeadline = Date.now() + 15_000;
  let composer = page.locator(dialogReplyBoxSelector).filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

  if (!(await composer.isVisible().catch(() => false))) {
    composer = page.locator(replyBoxSelector).filter({ visible: true }).first();
    const remainingMs = Math.max(1, replyBoxDeadline - Date.now());
    await composer.waitFor({ state: 'visible', timeout: remainingMs });
  }

  const composerDialog = composer.locator('xpath=ancestor::*[@role="dialog"][1]');
  const scope = (await composerDialog.count()) > 0 ? composerDialog : page;

  // focus() instead of click(): the modal mask can swallow pointer events.
  await composer.focus();
  await page.keyboard.type(reply, { delay: 20 });

  // Some drafts get swallowed by the editor; verify and re-insert if needed.
  const typed = await composer.innerText().catch(() => '');
  if (!typed.includes(reply.slice(0, Math.min(24, reply.length)))) {
    await composer.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(reply);
  }

  const postButton = scope.locator(SEL.postButton).first();
  await waitUntilEnabled(postButton, 30_000);
  await page.waitForTimeout(500);
  await postButton.click({ timeout: 30_000, force: true });

  await Promise.race([
    composer.waitFor({ state: 'detached', timeout: 30_000 }),
    page.locator(SEL.toast).first().waitFor({ state: 'visible', timeout: 30_000 }),
  ]).catch(() => console.warn('Warning: could not confirm the reply was sent — check the browser.'));
}

async function getCurrentAccountHandle(page, savedUsername) {
  const accountControl = page
    .locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Account_Menu_Button"]')
    .first();
  const [text, label] = await Promise.all([
    accountControl.innerText({ timeout: 5_000 }).catch(() => ''),
    accountControl.getAttribute('aria-label', { timeout: 5_000 }).catch(() => ''),
  ]);

  for (const value of [text, label]) {
    const match = String(value ?? '').match(/@([A-Za-z0-9_]{1,15})\b/);
    if (match) return match[1];
  }

  const profileHref = await page
    .locator('[data-testid="AppTabBar_Profile_Link"]')
    .first()
    .getAttribute('href', { timeout: 5_000 })
    .catch(() => '');
  const profileMatch = String(profileHref ?? '').match(/^\/@?([A-Za-z0-9_]{1,15})\/?$/);
  if (profileMatch) return profileMatch[1];

  const fallback = String(savedUsername ?? '').match(/^@?([A-Za-z0-9_]{1,15})$/);
  return fallback?.[1] ?? null;
}

async function hasCurrentAccountReply(page, currentHandle, tweetUrl) {
  if (!currentHandle) return false;

  const normalizedHandle = currentHandle.toLowerCase();
  const targetStatusId = tweetUrl.match(/\/status\/(\d+)/i)?.[1] ?? null;
  const conversation = page.locator('[aria-label="Timeline: Conversation"]');
  const articles = (await conversation.count()) > 0 ? conversation.locator(SEL.tweet) : page.locator(SEL.tweet);

  // Give X a short opportunity to render the first replies without scrolling the
  // target out of the virtualized timeline.
  await articles.nth(1).waitFor({ state: 'attached', timeout: 3_000 }).catch(() => {});

  const count = Math.min(await articles.count(), 50);
  let targetSeen = false;

  for (let index = 0; index < count; index += 1) {
    const article = articles.nth(index);
    const nested = await article
      .evaluate((node) => Boolean(node.parentElement?.closest('article[data-testid="tweet"]')))
      .catch(() => false);
    if (nested) continue;

    const permalink = await article
      .locator('a[href*="/status/"] time')
      .first()
      .evaluate((node) => node.closest('a')?.getAttribute('href') ?? '')
      .catch(() => '');
    const statusId = permalink.match(/\/status\/(\d+)/i)?.[1] ?? null;

    if (targetStatusId && statusId === targetStatusId) {
      targetSeen = true;
      continue;
    }
    if (!targetStatusId && !targetSeen) {
      targetSeen = true;
      continue;
    }
    if (!targetSeen) continue;

    const header = await article.locator(SEL.userName).first().innerText().catch(() => '');
    const author = header.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1]?.toLowerCase();
    if (author !== normalizedHandle) continue;

    const articleText = await article.innerText().catch(() => '');
    if (/\bReplying to\b/i.test(articleText)) return true;
  }

  return false;
}

async function auditEngagement(page, currentHandle, tweetUrl) {
  const tweet = page.locator(SEL.tweet).first();
  const liked = await tweet.locator(SEL.unlike).first().isVisible().catch(() => false);
  const replied = await hasCurrentAccountReply(page, currentHandle, tweetUrl);
  return { liked, replied };
}

async function likeTweet(page) {
  const tweet = page.locator(SEL.tweet).first();
  const unlikeButton = tweet.locator(SEL.unlike).first();
  const alreadyLiked = await unlikeButton.isVisible().catch(() => false);

  if (alreadyLiked) {
    console.log('[LIKE] Already liked. Skipping.');
    return 'already liked';
  }

  const likeButton = tweet.locator(SEL.like).first();
  const likeFallback = tweet.locator('button[aria-label*="Like"]').first();
  const likeTarget = (await likeButton.count()) > 0 ? likeButton : likeFallback;

  try {
    await tweet.scrollIntoViewIfNeeded();
    await likeTarget.waitFor({ state: 'visible', timeout: 30_000 });
    await likeTarget.click();
    await tweet.locator(SEL.unlike).first().waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    console.warn(`[LIKE] Like interaction failed: ${error?.message ?? error}`);
    return 'like failed';
  }

  return 'liked';
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.url) throw new Error(`Missing tweet URL.\n\n${USAGE}`);
  const urls = (options.url ?? '').split(/\s+/).map((u) => u.trim()).filter((u) => u.length > 0);
  const tweetUrl = urls.find((u) => TWEET_URL_PATTERN.test(u)) ?? urls[0];
  if (!tweetUrl) throw new Error(`Not a tweet URL: ${options.url}`);
  const groqApiKey = String(process.env.GROQ_API_KEY ?? '').trim();
  if (!groqApiKey) {
    throw new Error('Groq API key is not configured. Add one in the dashboard or GROQ_API_KEY in .env.');
  }
  process.env.GROQ_API_KEY = groqApiKey;
  const groqKeySource = process.env.GROQ_API_KEY_SOURCE === 'account' ? 'saved account' : 'environment';
  console.log(`[GROQ] Using API key from ${groqKeySource}.`);

  const authState = await loadAuthState();

  let browser = null;
  try {
    browser = await connectBrowser();
    const context = await getDefaultContext(browser);
    const restored = await safeContextCall(
      context,
      () => restoreStorageState(context, authState, { clearCookies: true }),
      'Restoring X session cookies and localStorage',
    );
    if (!restored.ok) {
      console.warn(`[AUTH] ${restored.error.message}. Nothing was posted.`);
      process.exitCode = 1;
      return;
    }
    const page = await getOrCreatePage(context);

    await ensureLoggedIn(page);

    console.log(`Opening ${tweetUrl} …`);
    const navigation = await safeGoto(page, tweetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (navigation.error) {
      console.warn(`[NAV] Navigation warning: ${navigation.error.message}. Continuing…`);
    } else if (navigation.response && navigation.response.status() >= 400) {
      console.warn(`[NAV] X returned HTTP ${navigation.response.status()} for ${tweetUrl}.`);
    }

    const tweet = await extractTweet(page);
    console.log(`\nTweet by @${tweet.author}:\n  ${truncate(tweet.text, 300)}\n`);

    if (options.audit) {
      const currentHandle = await getCurrentAccountHandle(page, authState.username);
      if (!currentHandle) {
        console.warn('[AUDIT] Could not determine the current account handle; reply detection may be incomplete.');
      }

      const engagement = await auditEngagement(page, currentHandle, tweetUrl);
      const auditEvent = {
        status: engagement.liked || engagement.replied ? 'engaged' : 'pending',
        url: tweetUrl,
        liked: engagement.liked,
        replied: engagement.replied,
      };
      console.log(`[AUDIT_EVENT] ${JSON.stringify(auditEvent)}`);

      if (auditEvent.status === 'engaged') {
        const reasons = [engagement.liked && 'liked', engagement.replied && 'replied'].filter(Boolean).join(' and ');
        console.log(`[AUDIT] Already ${reasons}. Skipping ${tweetUrl}.`);
        return;
      }

      console.log(`[AUDIT] Unengaged target pending. Processing ${tweetUrl}.`);
    }

    console.log('Asking Groq for a reply …');
    const { topic, reply } = await generateReply(tweet, undefined, options.tone);
    console.log(`\nDetected topic: ${topic}`);
    console.log(`Proposed reply (${reply.length}/${MAX_REPLY_LENGTH}):\n  ${reply}\n`);

    if (options.replyOut) {
      await writeFile(options.replyOut, reply, 'utf8');
    }

    if (options.dryRun) {
      console.log('Dry run — nothing was posted or liked.');
      return;
    }

    if (!options.yes) {
      const answer = (await ask('Post this reply and like the tweet? [Y/n] ')).toLowerCase();
      if (answer && !['y', 'yes'].includes(answer)) {
        console.log('Aborted — nothing was posted or liked.');
        return;
      }
    }

    if (options.reply) {
      console.log('Posting reply …');
      await postReply(page, reply);
      console.log('Reply posted.');
    }

    if (options.like) {
      try {
        console.log(`Like: ${await likeTweet(page)}.`);
      } catch (error) {
        console.error(`Like failed: ${error.message}`);
        process.exitCode = 1;
      }
    }

    console.log(`\nDone: ${tweetUrl}`);
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((error) => {
  if (error?.name === 'AbortError' || error?.code === 'ERR_USE_AFTER_CLOSE') {
    console.log('\nCancelled — nothing was posted.');
    process.exitCode = 130;
    return;
  }
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
});
