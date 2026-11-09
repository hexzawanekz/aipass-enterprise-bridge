// The Enterprise page script, tested without a browser. It has to answer the
// bridge's existing loader/create/chat jobs, and it must never post a captured
// bearer token back to the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, '..', 'extension', 'enterprise.js');
const SERVER = path.join(here, '..', 'bridge', 'server.mjs');

const serverSrc = fs.readFileSync(SERVER, 'utf8');
const decoderStart = serverSrc.indexOf('function decodeTurboStream');
const decoderEnd = serverSrc.indexOf('const LOADERS');
const decodeTurboStream = new Function(`${serverSrc.slice(decoderStart, decoderEnd)}\nreturn decodeTurboStream;`)();

const CID = 'ee270c27-3ddc-4345-a205-c8c9a31f5c44';
const HREF = `https://vertexaisearch.cloud.google/us/home/cid/${CID}?csesidx=1`;
const BEARER = 'Bearer test-token-do-not-leak';
const SERVER_TOKEN = 'server-token-do-not-leak';

function loadEnterprise({ onFetch } = {}) {
  const listeners = [];
  const sent = [];
  const requests = [];
  const location = { origin: 'https://vertexaisearch.cloud.google', href: HREF };
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    requests.push({ url, init });
    const answer = await onFetch(url, init, requests.length);
    if (answer instanceof Response) return answer;
    const status = answer?.status ?? 200;
    const body = answer?.body ?? answer ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const window = {
    location,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data) => { sent.push(data); },
    fetch: fetchImpl,
  };
  window.window = window;
  const src = fs.readFileSync(PAGE, 'utf8');
  const run = new Function('window', src);
  run(window);
  const deliver = (msg) => { for (const fn of listeners) fn({ source: window, data: msg }); };
  return {
    window,
    sent,
    requests,
    run: (job) => deliver({ __aipass_bridge: 'req', job }),
    settled: (jobId, timeout = 4000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const end = sent.find((m) => m.jobId === jobId && (m.kind === 'done' || m.kind === 'error' || m.kind === 'loader'));
        if (end) { clearInterval(tick); resolve(end); }
        else if (Date.now() - started > timeout) { clearInterval(tick); reject(new Error(`job ${jobId} never settled`)); }
      }, 10);
    }),
  };
}

function signIn(page) {
  return page.window.fetch('https://content-us-discoveryengine.googleapis.com/v1alpha/locations/us/lookupWidgetConfig', {
    method: 'POST',
    headers: {
      authorization: BEARER,
      'x-server-token': SERVER_TOKEN,
      'x-goog-api-client': 'gemini-enterprise-classic/1.0.0',
    },
  });
}

test('announces itself and serves a model the bridge can decode', async () => {
  const page = loadEnterprise({ onFetch: async () => ({}) });
  assert.ok(page.sent.some((m) => m.kind === 'page-ready'));
  page.run({ jobId: 'm', kind: 'loader', url: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models' });
  const end = await page.settled('m');
  const models = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string') models.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decodeTurboStream(end.raw));
  assert.equal(models[0].id, 'gemini-enterprise');
  assert.equal(models[0].providerName, 'gemini-enterprise');
});

test('a signed page call is reused for session create and assist, and never posted back', async () => {
  const page = loadEnterprise({
    onFetch: async (url) => {
      if (url.endsWith('/widgetCreateSession')) {
        return { body: { session: { name: 'projects/1/locations/us/sessions/abc' } } };
      }
      if (url.endsWith('/widgetAssist')) {
        return { body: { assistResponse: { replies: [{ groundedContent: { content: { text: 'ok' } } }] } } };
      }
      return { body: {} };
    },
  });
  await signIn(page);
  page.run({
    jobId: 'j1', kind: 'chat', conversationId: 'enterprise', modelId: 'gemini-enterprise',
    text: 'Reply with the single word: ok', parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
  });
  const end = await page.settled('j1');
  assert.equal(end.kind, 'done');
  const text = page.sent.filter((m) => m.jobId === 'j1' && m.kind === 'chunk')
    .flatMap((m) => m.parts).filter((p) => p.kind === 'text').map((p) => p.text).join('');
  assert.equal(text, 'ok');

  const assist = page.requests.find((r) => r.url.endsWith('/widgetAssist'));
  const created = page.requests.find((r) => r.url.endsWith('/widgetCreateSession'));
  assert.ok(assist && created);
  const headers = new Headers(assist.init.headers);
  assert.equal(headers.get('authorization'), BEARER);
  assert.equal(headers.get('x-server-token'), SERVER_TOKEN);
  const body = JSON.parse(assist.init.body);
  assert.equal(body.configId, CID);
  assert.equal(body.additionalParams.token, '-');
  assert.equal(body.assistRequest.query.parts[0].text, 'Reply with the single word: ok');
  assert.equal(body.assistRequest.session, 'projects/1/locations/us/sessions/abc');
  const posted = JSON.stringify(page.sent);
  assert.equal(posted.includes(BEARER), false);
  assert.equal(posted.includes(SERVER_TOKEN), false);
  assert.equal(posted.includes('test-token'), false);
});

test('a 400 on parts retries with a plain text query', async () => {
  let assists = 0;
  const page = loadEnterprise({
    onFetch: async (url) => {
      if (url.endsWith('/widgetCreateSession')) return { body: { session: { name: 'sessions/1' } } };
      if (url.endsWith('/widgetAssist')) {
        assists += 1;
        if (assists === 1) return { status: 400, body: { error: { message: 'query.parts is not valid' } } };
        return { body: { assistResponse: { replies: [{ groundedContent: { content: { text: 'retried' } } }] } } };
      }
      return { body: {} };
    },
  });
  await signIn(page);
  page.run({ jobId: 'j2', kind: 'chat', conversationId: 'c', text: 'hi', parts: [{ type: 'text', text: 'hi' }] });
  const end = await page.settled('j2');
  assert.equal(end.kind, 'done');
  const bodies = page.requests.filter((r) => r.url.endsWith('/widgetAssist')).map((r) => JSON.parse(r.init.body));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].assistRequest.query, { text: 'hi' });
});

test('chat before any signed call fails without inventing a token', async () => {
  const page = loadEnterprise({ onFetch: async () => ({}) });
  page.run({ jobId: 'j3', kind: 'chat', conversationId: 'c', text: 'hi' });
  const end = await page.settled('j3', 9000);
  assert.equal(end.kind, 'error');
  assert.match(end.message, /Reload the Gemini Enterprise tab/);
  assert.equal(page.requests.some((r) => r.url.includes('widgetAssist')), false);
});
