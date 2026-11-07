import test from 'node:test';
import assert from 'node:assert/strict';
import { postReply } from '../main.js';

const REPLY = 'A synthetic reply used only by local tests.';
const VERIFICATION_ERROR = 'Reply verification failed: Post was not confirmed on X';

function response({
  url = 'https://x.com/i/api/graphql/test-query/CreateTweet',
  method = 'POST',
  ok = true,
  payload = { data: { create_tweet: { tweet_results: { result: { rest_id: '123' } } } } },
} = {}) {
  return { url: () => url, request: () => ({ method: () => method }), ok: () => ok, json: async () => payload };
}

// Exercise the actual reply handler without contacting X or opening a browser.
function fixture({ responses = [], rendered = false, existingReplies = 0 } = {}) {
  let responsePredicate;
  let resolveResponse;
  let rejectResponse;
  let clicked = false;
  let typed = '';

  const postButton = {
    first() { return this; },
    isEnabled: async () => true,
    async click() {
      assert.ok(responsePredicate, 'CreateTweet listener must be armed before clicking Post');
      clicked = true;
      for (const candidate of responses) {
        if (await responsePredicate(candidate)) {
          resolveResponse(candidate);
          return;
        }
      }
      rejectResponse(new Error('Response timeout'));
    },
  };
  const dialog = { count: async () => 1, locator: () => postButton };
  const composer = {
    waitFor: async () => {}, isVisible: async () => true, focus: async () => {},
    innerText: async () => typed, locator: () => dialog,
  };
  const composerLocator = { filter() { return this; }, first: () => composer };
  const matchingReplies = {
    async count() {
      assert.equal(clicked, false, 'Existing replies must be counted before posting');
      return existingReplies;
    },
    nth(index) {
      assert.equal(index, existingReplies, 'Only a new matching tweet can verify this reply');
      return {
        async waitFor({ state, timeout }) {
          assert.equal(clicked, true);
          assert.equal(state, 'visible');
          assert.equal(timeout, 5_000);
          if (!rendered) throw new Error('Reply was not rendered');
        },
      };
    },
  };
  const tweetText = { filter({ hasText }) { assert.equal(hasText, REPLY); return this; } };
  const tweet = { locator: () => ({ first: () => ({ click: async () => {} }) }) };
  const tweets = { first: () => tweet, filter: () => matchingReplies };
  return {
    locator(selector) {
      if (selector === 'article[data-testid="tweet"]') return tweets;
      if (selector === '[data-testid="tweetText"]') return tweetText;
      return composerLocator;
    },
    keyboard: { type: async (text) => { typed = text; } },
    waitForTimeout: async () => {},
    waitForResponse(predicate, { timeout }) {
      assert.equal(timeout, 5_000);
      responsePredicate = predicate;
      return new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    },
  };
}

test('reply verification accepts a successful CreateTweet response with a created tweet ID', async () => {
  await postReply(fixture({ responses: [response()] }), REPLY);
});

test('reply verification accepts a newly rendered reply when no API response is captured', async () => {
  await postReply(fixture({ rendered: true, existingReplies: 2 }), REPLY);
});

test('reply verification throws the explicit error if neither confirmation arrives', async () => {
  await assert.rejects(postReply(fixture(), REPLY), { message: VERIFICATION_ERROR });
});

test('an existing tweet with the same reply text does not confirm a new post', async () => {
  await assert.rejects(postReply(fixture({ existingReplies: 1 }), REPLY), { message: VERIFICATION_ERROR });
});

test('HTTP failures, GraphQL errors, and empty CreateTweet results cannot confirm a reply', async () => {
  for (const candidate of [
    response({ ok: false }),
    response({ payload: { errors: [{ message: 'Synthetic API failure' }] } }),
    response({ payload: { data: { create_tweet: {} } } }),
  ]) {
    await assert.rejects(postReply(fixture({ responses: [candidate] }), REPLY), { message: VERIFICATION_ERROR });
  }
});

test('unrelated network responses are ignored during reply verification', async () => {
  for (const candidate of [
    response({ url: 'https://x.com/i/api/graphql/test-query/CreateRetweet' }),
    response({ url: 'https://unrelated.example/i/api/graphql/test-query/CreateTweet' }),
    response({ method: 'GET' }),
  ]) {
    await assert.rejects(postReply(fixture({ responses: [candidate] }), REPLY), { message: VERIFICATION_ERROR });
  }
});
