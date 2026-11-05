export const MAX_REPLY_LENGTH = 240;

export const TOPICS = [
  'crypto',
  'web-development',
  'software-engineering',
  'ui-ux-design',
  'ai-ml',
  'product-startup',
  'other',
];

// Only used as a safety net: if a non-crypto tweet somehow yields crypto jargon, regenerate once.
const CRYPTO_JARGON =
  /\b(crypto|web3|web 3|blockchain|on-?chain|defi|nft|nfts|airdrop|degen|altcoin|memecoin|shitcoin|satoshi|btc|eth|solana|tvl|staking|liquidity pool|bullish|bearish|dapp|gas fees?)\b/i;

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
let cachedGroqModel = null;

export const TONES = [
  { id: 'analytical', label: 'Analytical' },
  { id: 'casual-hype', label: 'Casual/Hype' },
  { id: 'brief-direct', label: 'Brief & Direct' },
  { id: 'technical-web3', label: 'Technical/Web3' },
];

export const DEFAULT_TONE = 'neutral';

export function resolveTone(tone) {
  const id = String(tone ?? '').trim().toLowerCase();
  const found = TONES.find((t) => t.id === id);
  return found ? found.label : 'Neutral';
}

export function sanitizeReply(text) {
  let reply = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+/, '')
    .replace(/["'“”]+$/, '')
    .trim();

  reply = reply.replace(/^(\*\*Reply:\*\*|Reply:|>|\s)+/gi, '').trim();

  if (!reply) throw new Error('Groq produced an empty reply.');
  if (reply.length > MAX_REPLY_LENGTH) {
    const cut = reply.slice(0, MAX_REPLY_LENGTH);
    reply = cut.slice(0, Math.max(cut.lastIndexOf(' '), 120)).trim();
  }

  return reply;
}

export async function getActiveGroqModel() {
  if (cachedGroqModel) return cachedGroqModel;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set — cannot discover Groq models.');

  const res = await fetch(GROQ_MODELS_URL, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[GROQ MODELS ERROR]', res.status, errBody);
    throw new Error(`Groq models request failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const textModelIds = (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string');
  const chosen =
    ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'].find((id) => textModelIds.includes(id)) ??
    process.env.DEFAULT_GROQ_MODEL ??
    'llama-3.1-8b-instant';
  cachedGroqModel = chosen;
  console.log(`[GROQ] Active model verified: ${chosen}`);
  return chosen;
}

async function generateViaGroq(tweet, log = console.error, tone = DEFAULT_TONE) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set — cannot use the Groq fallback.');

  const toneLabel = resolveTone(tone);
  const prompt = `Tweet by @${tweet.author}:\n"""\n${tweet.text}\n"""\n\nWrite the reply.\n\nTone preference: ${toneLabel}.`;

  const model = await getActiveGroqModel();
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a sharp social-reply writer for X. Write short, punchy, concise replies. Keep every reply well under the free-tier character ceiling (ideally under 200 characters) and punchy — no fluff.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[GROQ ERROR]', res.status, errBody);
    throw new Error(`Groq API Failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Groq returned an empty response.');

  let topic = 'other';
  let reply = content;
  try {
    const parsed = JSON.parse(content);
    topic = TOPICS.includes(parsed.topic) ? parsed.topic : 'other';
    reply = parsed.reply ?? content;
  } catch {
    /* keep plain text */
  }

  return { topic, reply: sanitizeReply(reply) };
}

export async function generateReply(tweet, log = console.error, tone = DEFAULT_TONE) {
  const draft = await generateViaGroq(tweet, log, tone);

  // Safety net: a non-crypto post must not get crypto-flavoured vocabulary.
  if (draft.topic !== 'crypto' && CRYPTO_JARGON.test(draft.reply)) {
    log('  reply drifted into crypto jargon — regenerating …');
    return await generateViaGroq(tweet, log, tone);
  }

  return draft;
}
