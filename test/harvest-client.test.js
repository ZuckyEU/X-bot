import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HARVEST_API_URL,
  harvestXAccount,
  resolveHarvestConfig,
} from '../lib/harvest-client.js';

function mockFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

test('harvest client resolves the Fly.io default and requires a token', () => {
  assert.deepEqual(
    resolveHarvestConfig({ token: 'secret-token' }),
    { url: DEFAULT_HARVEST_API_URL, token: 'secret-token' },
  );
  assert.throws(() => resolveHarvestConfig({ token: '' }), /HARVEST_API_TOKEN is required/);
  assert.throws(() => resolveHarvestConfig({ token: 'x', apiUrl: 'not-a-url' }), /http\(s\) URL/);
});

test('harvest client sends bearer auth and returns X cookies', async () => {
  const { calls, fetchImpl } = mockFetch({
    ok: true,
    username: 'alice',
    cookies: [
      { name: 'auth_token', value: 'auth-value' },
      { name: 'ct0', value: 'csrf-value' },
      { name: 'guest_id', value: 'ignored' },
    ],
  });

  const result = await harvestXAccount({
    identifier: ' @alice ',
    password: 'Password-123!',
    apiUrl: 'https://example.test/api/harvest-token',
    token: 'harvest-token',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/harvest-token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer harvest-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    identifier: '@alice',
    password: 'Password-123!',
  });
  assert.equal(result.username, 'alice');
  assert.equal(result.authToken, 'auth-value');
  assert.equal(result.ct0, 'csrf-value');
  assert.deepEqual(result.cookies.map((cookie) => cookie.name), ['auth_token', 'ct0']);
});

test('harvest client forwards an optional 2FA code', async () => {
  const { calls, fetchImpl } = mockFetch({
    ok: true,
    username: 'alice',
    cookies: [
      { name: 'auth_token', value: 'auth-value' },
      { name: 'ct0', value: 'csrf-value' },
    ],
  });

  await harvestXAccount({
    identifier: 'alice',
    password: 'Password-123!',
    twoFactorCode: 123456,
    apiUrl: 'https://example.test/api/harvest-token',
    token: 'harvest-token',
    fetchImpl,
  });

  assert.equal(JSON.parse(calls[0].options.body).twoFactorCode, '123456');
});

test('harvest client surfaces service errors', async () => {
  const { fetchImpl } = mockFetch({ ok: false, error: 'X login failed' }, 502);

  await assert.rejects(
    () => harvestXAccount({
      identifier: 'alice',
      password: 'Password-123!',
      apiUrl: 'https://example.test/api/harvest-token',
      token: 'harvest-token',
      fetchImpl,
    }),
    /X login failed/,
  );
});

test('harvest client rejects incomplete cookie responses', async () => {
  const { fetchImpl } = mockFetch({
    ok: true,
    username: 'alice',
    cookies: [{ name: 'auth_token', value: 'auth-value' }],
  });

  await assert.rejects(
    () => harvestXAccount({
      identifier: 'alice',
      password: 'Password-123!',
      apiUrl: 'https://example.test/api/harvest-token',
      token: 'harvest-token',
      fetchImpl,
    }),
    /did not include auth_token and ct0/,
  );
});
