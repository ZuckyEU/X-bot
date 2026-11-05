import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { closeBrowser, connectBrowser, getDefaultContext, getOrCreatePage } from './lib/browser.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.6-flash';

async function scrapeTitle(url) {
  let browser = null;
  try {
    browser = await connectBrowser();
    const context = await getDefaultContext(browser);
    const page = await getOrCreatePage(context);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return {
      url: page.url(),
      title: await page.title(),
      heading: (await page.locator('h1').first().textContent().catch(() => null))?.trim() ?? null,
    };
  } finally {
    await closeBrowser(browser);
  }
}

async function main() {
  const target = process.argv[2] ?? 'https://example.com';

  console.log(`Connecting to Browserless Chromium and visiting ${target} ...`);
  const pageInfo = await scrapeTitle(target);
  console.log('Page:', pageInfo);

  if (!process.env.GEMINI_API_KEY) {
    console.warn('\nGEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: `In one short sentence, describe this page: title=${JSON.stringify(pageInfo.title)}, heading=${JSON.stringify(pageInfo.heading)}.`,
  });

  console.log(`\nGemini (${MODEL}):`, response.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
