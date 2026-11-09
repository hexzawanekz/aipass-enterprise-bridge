// MAIN world, Gemini Enterprise only (vertexaisearch.cloud.google).
//
// The page already signs Discovery Engine calls with a bearer token and an
// X-Server-Token. This script watches those calls, then repeats the same
// request shape for bridge jobs. Tokens stay in this page. Replies that go
// back to the bridge are text only.
(() => {
  const GEN = (window.__aipassEnterpriseGen ?? 0) + 1;
  window.__aipassEnterpriseGen = GEN;
  const current = () => window.__aipassEnterpriseGen === GEN;

  const TAG = '__aipass_bridge';
  const API_CLIENT = 'gemini-enterprise-classic/1.0.0';
  const AUTH_WAIT_MS = 8000;

  const auth = window.__aipassEnterpriseAuth ?? (window.__aipassEnterpriseAuth = {
    authorization: '',
    serverToken: '',
    apiClient: API_CLIENT,
    base: '',
  });
  const sessions = window.__aipassEnterpriseSessions ?? (window.__aipassEnterpriseSessions = new Map());
  const inflight = new Map();

  const reply = (msg) => window.postMessage({ [TAG]: 'res', ...msg }, window.location.origin);

  function headerBag(input, init) {
    const bag = new Headers();
    if (typeof Request !== 'undefined' && input instanceof Request) {
      input.headers.forEach((value, key) => bag.set(key, value));
    }
    if (init?.headers) new Headers(init.headers).forEach((value, key) => bag.set(key, value));
    return bag;
  }

  function noteExchange(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url !== 'string' || !url.includes('discoveryengine.googleapis.com')) return;
    const headers = headerBag(input, init);
    const authorization = headers.get('authorization') || '';
    const serverToken = headers.get('x-server-token') || '';
    const apiClient = headers.get('x-goog-api-client') || '';
    if (authorization) auth.authorization = authorization;
    if (serverToken) auth.serverToken = serverToken;
    if (apiClient) auth.apiClient = apiClient;
    const match = url.match(/^(https:\/\/[^/]+)(\/v1alpha\/locations\/[^/]+)/);
    if (match) auth.base = match[1] + match[2];
  }

  if (!window.__aipassEnterpriseFetchWrapped) {
    window.__aipassEnterpriseFetchWrapped = true;
    const orig = window.fetch.bind(window);
    window.__aipassEnterpriseOrigFetch = orig;
    window.fetch = function enterpriseFetch(input, init) {
      try { noteExchange(input, init); } catch { /* a failed note must not break the page */ }
      return orig(input, init);
    };
  }
  const origFetch = window.__aipassEnterpriseOrigFetch;

  function configId() {
    const match = String(window.location.href).match(
      /\/cid\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    return match ? match[1] : '';
  }

  // react-router turbo-stream: objects address keys and values by pool index.
  // The bridge's decodeTurboStream starts at index 0, so the root is written first.
  function encodeTurbo(value) {
    const flat = [];
    const scalars = new Map();
    const put = (v) => {
      if (v == null) return -1;
      const type = typeof v;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        const key = `${type}:${v}`;
        if (scalars.has(key)) return scalars.get(key);
        const index = flat.length;
        flat.push(v);
        scalars.set(key, index);
        return index;
      }
      if (Array.isArray(v)) {
        const index = flat.length;
        flat.push([]);
        flat[index] = v.map(put);
        return index;
      }
      if (type === 'object') {
        const index = flat.length;
        flat.push({});
        const obj = {};
        for (const [key, val] of Object.entries(v)) obj[`_${put(key)}`] = put(val);
        flat[index] = obj;
        return index;
      }
      return -1;
    };
    put(value);
    return JSON.stringify(flat);
  }

  const MODEL = {
    id: 'gemini-enterprise',
    displayName: 'Gemini Enterprise',
    providerName: 'gemini-enterprise',
    provider: 'gemini-enterprise',
    description: 'The model selected in the open Gemini Enterprise tab',
    isDefault: true,
  };

  const conversationRow = () => ({
    id: 'enterprise',
    title: 'Gemini Enterprise',
    updatedAt: new Date().toISOString(),
    isTemporary: false,
  });

  function loaderRaw(url) {
    const path = String(url).split('?')[0];
    if (path.includes('list-models')) return encodeTurbo([MODEL]);
    if (path.includes('list-conversations')) return encodeTurbo([conversationRow()]);
    // The classic credit pool does not exist on Enterprise. Failing the loader
    // leaves the bridge's quota cache empty, which doctor already reports as a warning.
    if (path.includes('get-usage-quota')) throw new Error('Gemini Enterprise does not expose the classic credit pool.');
    throw new Error(`Gemini Enterprise has no classic loader for ${path}`);
  }

  async function runLoader(job) {
    try {
      reply({ jobId: job.jobId, kind: 'loader', raw: loaderRaw(job.url) });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  async function runCreate(job) {
    try {
      const id = String(job.requestId ?? '').replace(/-/g, '').slice(0, 16) || `e${Date.now().toString(16)}`;
      reply({
        jobId: job.jobId,
        kind: 'loader',
        raw: encodeTurbo({ id, conversationId: id, title: 'Gemini Enterprise' }),
      });
    } catch (err) {
      reply({ jobId: job.jobId, kind: 'loader', message: String(err?.message ?? err) });
    }
  }

  function redact(text) {
    return String(text)
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
      .slice(0, 300);
  }

  async function waitForAuth(signal) {
    const started = Date.now();
    while (!auth.authorization || !auth.base) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (Date.now() - started > AUTH_WAIT_MS) {
        throw new Error('Reload the Gemini Enterprise tab so a signed API call can be captured, then try again.');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function widget(method, body, signal) {
    const cid = configId();
    if (!cid) throw new Error('This Enterprise URL has no widget id. Open the home page that contains /cid/.');
    const headers = {
      'content-type': 'application/json',
      authorization: auth.authorization,
      'x-goog-api-client': auth.apiClient || API_CLIENT,
    };
    if (auth.serverToken) headers['x-server-token'] = auth.serverToken;
    const res = await origFetch(`${auth.base}/${method}`, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers,
      body: JSON.stringify({
        configId: cid,
        additionalParams: { token: '-', origin: 'ORIGIN_UNSPECIFIED' },
        ...body,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.error?.message || json?.error?.status || `${method} returned ${res.status}`;
      const error = new Error(redact(message));
      error.status = res.status;
      throw error;
    }
    return json;
  }

  function sessionName(payload) {
    const session = payload?.session;
    if (typeof session === 'string' && session) return session;
    if (session && typeof session.name === 'string') return session.name;
    return '';
  }

  function mergePieces(pieces) {
    const out = [];
    for (const piece of pieces) {
      if (out.some((kept) => kept.includes(piece))) continue;
      for (let i = out.length - 1; i >= 0; i--) {
        if (piece.includes(out[i])) out.splice(i, 1);
      }
      out.push(piece);
    }
    return out.join('');
  }

  function collectAnswer(payload) {
    const text = [];
    const reasoning = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const content = node.groundedContent?.content;
      if (content && typeof content.text === 'string' && content.text.trim()) {
        (content.thought ? reasoning : text).push(content.text);
      }
      Object.values(node).forEach(walk);
    };
    walk(payload?.assistResponse ?? payload);
    return { text: mergePieces(text), reasoning: mergePieces(reasoning) };
  }

  async function ensureSession(conversationId, signal) {
    const key = conversationId || 'enterprise';
    const cached = sessions.get(key);
    if (cached) return cached;
    const created = await widget('widgetCreateSession', {
      createSessionRequest: {
        session: { name: '-', displayName: 'aipass bridge' },
      },
    }, signal);
    const name = sessionName(created);
    if (!name) throw new Error('Gemini Enterprise did not return a session name.');
    sessions.set(key, name);
    return name;
  }

  function assistRequest(session, query) {
    return {
      session,
      query,
      languageCode: 'en-GB',
      userMetadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC' },
    };
  }

  // The widget client attaches fields the REST method does not accept. A 400
  // names the offender ("Unknown name \"toolsSpec\""), so drop that field and
  // send the request again rather than failing the turn.
  async function ask(session, text, signal) {
    const queries = [{ parts: [{ text }] }, { text }];
    let last = null;
    for (const query of queries) {
      const request = assistRequest(session, query);
      let stripped = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          return await widget('widgetAssist', { assistRequest: request }, signal);
        } catch (err) {
          last = err;
          const unknown = /Unknown name "([^"]+)"/.exec(String(err?.message ?? ''));
          if (unknown && Object.prototype.hasOwnProperty.call(request, unknown[1])) {
            delete request[unknown[1]];
            stripped = true;
            continue;
          }
          break;
        }
      }
      if (stripped) continue;
      if (last?.status !== 400) break;
    }
    throw last ?? new Error('Gemini Enterprise did not answer.');
  }

  async function runChat(job) {
    const controller = new AbortController();
    inflight.set(job.jobId, controller);
    try {
      const text = String(job.text ?? '').trim();
      if (!text) throw new Error('The message was empty.');
      if ((job.parts ?? []).some((part) => part && part.type && part.type !== 'text')) {
        throw new Error('This Enterprise tab accepts text. Image and file attachments stay on the classic chat tab.');
      }
      reply({ jobId: job.jobId, kind: 'chunk', parts: [{ kind: 'status', text: 'asking Gemini Enterprise' }] });
      await waitForAuth(controller.signal);
      const session = await ensureSession(job.conversationId, controller.signal);
      const payload = await ask(session, text, controller.signal);
      const answer = collectAnswer(payload);
      if (!answer.text && !answer.reasoning) {
        const keys = Object.keys(payload ?? {}).slice(0, 8).join(', ') || 'empty';
        throw new Error(`Gemini Enterprise returned no text (${keys}).`);
      }
      const parts = [];
      if (answer.reasoning) parts.push({ kind: 'reasoning', text: answer.reasoning });
      if (answer.text) parts.push({ kind: 'text', text: answer.text });
      reply({ jobId: job.jobId, kind: 'chunk', parts });
      reply({ jobId: job.jobId, kind: 'done', finishReason: 'stop' });
    } catch (err) {
      if (err?.name === 'AbortError') reply({ jobId: job.jobId, kind: 'done', finishReason: 'stop' });
      else reply({ jobId: job.jobId, kind: 'error', message: redact(err?.message ?? err) });
    } finally {
      inflight.delete(job.jobId);
    }
  }

  function unsupported(job, message) {
    reply({ jobId: job.jobId, kind: 'error', message });
  }

  window.addEventListener('message', (event) => {
    if (!current()) return;
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg[TAG] === 'abort') {
      inflight.get(msg.jobId)?.abort();
      return;
    }
    if (msg[TAG] !== 'req') return;
    const job = msg.job ?? {};
    if (job.kind === 'loader') runLoader(job);
    else if (job.kind === 'create') runCreate(job);
    else if (job.kind === 'chat') runChat(job);
    else if (job.kind === 'video') unsupported(job, 'Video jobs run on the classic AiPASS chat tab. Close this Enterprise tab so the bridge can reach it.');
    else if (job.kind === 'assistant') unsupported(job, 'Custom assistants run on the classic AiPASS chat tab. Close this Enterprise tab so the bridge can reach it.');
    else unsupported(job, `Gemini Enterprise does not handle ${job.kind || 'this'} job.`);
  });

  reply({ kind: 'page-ready' });
})();
