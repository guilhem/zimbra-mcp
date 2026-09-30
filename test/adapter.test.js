import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker.js';
import { ZimbraReader, soapEndpoint } from '../src/zimbra.js';
import { TOOLS } from '../src/tools.js';

const ENV = { MCP_AUTH_MODE: 'sites', MCP_ALLOWED_USER_ID: 'test-owner', ZIMBRA_URL: 'https://mail.example.org/',
  ZIMBRA_USER: 'fixture@example.org', ZIMBRA_PASSWORD: 'fixture-password-not-real' };
const TOKEN = 'fixture-token-not-real';
const auth = { Body: { AuthResponse: { authToken: [{ _content: TOKEN }], lifetime: 172800000 } } };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'text/javascript' } });
const fault = code => ({ Body: { Fault: { Reason: { Text: `Do not leak ${ENV.ZIMBRA_PASSWORD} ${TOKEN}` }, Detail: { Error: { Code: code } } } } });
const req = (method, params, headers = {}, extra = {}) => new Request('https://reader.example/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), ...extra,
});
const owner = { 'oai-authenticated-user-id': ENV.MCP_ALLOWED_USER_ID };
const call = (name, args, headers = owner) => req('tools/call', { name, arguments: args }, headers);
function mockQueue(...values) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) });
    assert.ok(values.length, 'unexpected upstream request');
    const value = values.shift();
    if (value instanceof Error) throw value;
    return response(value?.data ?? value, value?.status ?? 200);
  };
  return { calls, fetcher };
}

test('discovery is bounded, credential-free, and contains only annotated read tools', async () => {
  const result = await (await handle(req('tools/list'), {})).json();
  assert.deepEqual(result.result.tools.map(t => t.name), ['zimbra_search_messages', 'zimbra_get_message', 'zimbra_list_folders', 'zimbra_list_tags']);
  assert.equal(JSON.stringify(result).includes(ENV.ZIMBRA_USER), false);
  for (const tool of TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('all data calls fail closed before fetch when missing or wrong trusted identity', async () => {
  let calls = 0; const fetcher = async () => { calls++; throw new Error(); };
  for (const [env, headers, status] of [[{}, owner, 503], [ENV, {}, 401], [ENV, { 'oai-authenticated-user-id': 'other-user' }, 403],
    [{ ...ENV, MCP_AUTH_MODE: 'public' }, owner, 503]]) {
    for (const tool of TOOLS) assert.equal((await handle(call(tool.name, {}, headers), env, fetcher)).status, status);
  }
  assert.equal(calls, 0);
});

test('unknown writes and raw SOAP tools never reach upstream', async () => {
  for (const name of ['zimbra_delete_messages', 'zimbra_send_message', 'download_attachment', 'request', 'MsgActionRequest']) {
    const result = await (await handle(call(name, {}), ENV, () => assert.fail('must not fetch'))).json();
    assert.equal(result.error.code, -32602);
  }
});

test('email allowlist also requires a trusted user ID, and both configured identities must match', async () => {
  const env = { ...ENV, MCP_ALLOWED_USER_ID: '', MCP_ALLOWED_USER_EMAIL: 'owner@example.org' };
  const wrong = [{ 'oai-authenticated-user-email': 'owner@example.org' },
    { ...owner, 'oai-authenticated-user-email': 'wrong@example.org' }, owner];
  for (const headers of wrong) assert.ok([401, 403].includes((await handle(call('zimbra_list_tags', {}, headers), env, () => assert.fail())).status));
  const q = mockQueue(auth, { Body: { GetTagResponse: {} } });
  const result = await handle(call('zimbra_list_tags', {}, { ...owner, 'oai-authenticated-user-email': 'OWNER@example.org' }), env, q.fetcher);
  assert.equal(result.status, 200);
  assert.equal((await handle(call('zimbra_list_tags', {}, { ...owner, 'oai-authenticated-user-email': 'owner@example.org' }),
    { ...env, MCP_ALLOWED_USER_ID: 'different-user' }, () => assert.fail())).status, 403);
});

test('read search uses only Auth and Search, and explicitly preserves unread state', async () => {
  const q = mockQueue(auth, { Body: { SearchResponse: { m: [{ id: '123', su: 'Hello', fr: 'Preview', e: [{ a: 'sender@example.org', t: 'f' }] }], more: true } } });
  const result = await (await handle(call('zimbra_search_messages', { query: 'in:inbox is:unread' }), ENV, q.fetcher)).json();
  assert.equal(result.result.structuredContent.messages[0].subject, 'Hello');
  assert.equal(result.result.structuredContent.more, true);
  assert.equal(q.calls.length, 2);
  const search = q.calls[1].body.Body.SearchRequest;
  assert.equal(search.read, false); assert.equal(search.fetch, 'none'); assert.equal(search.query, 'in:inbox is:unread');
  assert.equal(search.types, 'message'); assert.equal(search.limit, 20);
  assert.equal(q.calls[0].body.Body.AuthRequest.persistAuthTokenCookie, false);
  assert.equal(q.calls[0].options.headers.Cookie, undefined);
  assert.equal(q.calls[1].options.headers.Cookie, `ZM_AUTH_TOKEN=${TOKEN}`);
  assert.equal(q.calls[1].body.Header.context.authToken._content, TOKEN);
  assert.equal(q.calls.every(c => c.url === 'https://mail.example.org/service/soap' && c.options.redirect === 'manual'), true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('native fetch retains the global receiver in Workers runtimes', async () => {
  const q = mockQueue(auth, { Body: { GetTagResponse: {} } });
  function hostFetch(url, options) {
    assert.equal(this, globalThis, 'native fetch must not receive a ZimbraReader instance');
    return q.fetcher(url, options);
  }
  const result = await (await handle(call('zimbra_list_tags', {}), ENV, hostFetch)).json();
  assert.equal(result.result.isError, false);
  assert.equal(q.calls.length, 2);
});

test('redirects are rejected without following a Location or exposing its URL', async () => {
  let count = 0;
  const result = await (await handle(call('zimbra_list_tags', {}), ENV, async (_, options) => {
    count++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://unapproved.invalid/?secret=never-expose' } });
  })).json();
  assert.equal(count, 1);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /UPSTREAM_REDIRECT_BLOCKED/);
  assert.equal(JSON.stringify(result).includes('never-expose'), false);
});

test('GetMsg has read=false, strips HTML/remote URLs and reports attachment metadata/truncation', async () => {
  const q = mockQueue(auth, { Body: { GetMsgResponse: { m: [{ id: '123', su: 'A message', mp: [{ ct: 'multipart/mixed', mp: [
    { ct: 'text/plain', content: 'Hi', truncated: true }, { ct: 'text/html', content: '<img src="https://tracking.invalid/pixel">' },
    { ct: 'application/pdf', cd: 'attachment', part: '2', filename: 'doc.pdf', s: 42, content: 'never-return-binary' },
  ] }] }] } } });
  const result = await (await handle(call('zimbra_get_message', { id: '123' }), ENV, q.fetcher)).json();
  const m = result.result.structuredContent;
  assert.equal(m.body, 'Hi'); assert.equal(m.body_truncated, true); assert.equal(m.attachments[0].filename, 'doc.pdf');
  assert.equal(JSON.stringify(m).includes('tracking.invalid'), false); assert.equal(JSON.stringify(m).includes('never-return-binary'), false);
  assert.equal(q.calls[1].body.Body.GetMsgRequest.m.read, false); assert.equal(q.calls[1].body.Body.GetMsgRequest.m.neuter, true);
});

test('folders and tags map only expected metadata', async () => {
  const folders = mockQueue(auth, { Body: { GetFolderResponse: { folder: [{ id: '1', name: 'root', secret: TOKEN, folder: [{ id: '2', name: 'Inbox', u: 3 }] }] } } });
  const f = await (await handle(call('zimbra_list_folders', {}), ENV, folders.fetcher)).json();
  assert.equal(f.result.structuredContent.folders[0].children[0].name, 'Inbox');
  assert.equal(folders.calls[1].body.Body.GetFolderRequest.tr, false);
  assert.equal(JSON.stringify(f).includes(TOKEN), false);
  const tags = mockQueue(auth, { Body: { GetTagResponse: { tag: [{ id: '1', name: 'Work' }] } } });
  const t = await (await handle(call('zimbra_list_tags', {}), ENV, tags.fetcher)).json();
  assert.equal(t.result.structuredContent.tags[0].name, 'Work');
});

test('wide and deep folder trees obey a shared output budget', async () => {
  let deep = { id: 'leaf' };
  for (let i = 0; i < 30; i++) deep = { id: String(i), folder: [deep] };
  for (const root of [{ id: 'root', folder: Array.from({ length: 10000 }, (_, i) => ({ id: String(i) })) }, deep]) {
    const q = mockQueue(auth, { Body: { GetFolderResponse: { folder: [root] } } });
    const r = await (await handle(call('zimbra_list_folders', {}), ENV, q.fetcher)).json();
    assert.equal(r.result.structuredContent.truncated, true);
    let count = 0; const queue = [...r.result.structuredContent.folders];
    while (queue.length) { const value = queue.pop(); count++; queue.push(...value.children); }
    assert.ok(count <= 1000);
    assert.ok(JSON.stringify(r).length < 100000);
  }
});

test('attached message parts are not traversed into bodies', async () => {
  const q = mockQueue(auth, { Body: { GetMsgResponse: { m: [{ id: '1', mp: [{ ct: 'message/rfc822', filename: 'forwarded.eml',
    mp: [{ ct: 'text/plain', content: 'ATTACHED_MESSAGE_BODY' }] }] }] } } });
  const r = await (await handle(call('zimbra_get_message', { id: '1' }), ENV, q.fetcher)).json();
  assert.equal(r.result.structuredContent.body, '');
  assert.equal(r.result.structuredContent.attachments[0].filename, 'forwarded.eml');
  assert.equal(JSON.stringify(r).includes('ATTACHED_MESSAGE_BODY'), false);
});

test('HTML-only messages use inert text fallback and never include attached HTML', async () => {
  const q = mockQueue(auth, { Body: { GetMsgResponse: { m: [{ id: '1', mp: [{ ct: 'text/html', content: '<p>Readable &amp; useful</p><script>PRIVATE_SCRIPT</script>' },
    { ct: 'text/html', filename: 'attached.html', content: '<p>ATTACHED_HTML</p>' }] }] } } });
  const r = await (await handle(call('zimbra_get_message', { id: '1' }), ENV, q.fetcher)).json();
  assert.equal(r.result.structuredContent.body, 'Readable & useful');
  assert.equal(r.result.structuredContent.body_format, 'html_text');
  assert.doesNotMatch(r.result.structuredContent.body, /PRIVATE_SCRIPT|ATTACHED_HTML/);
  assert.equal(q.calls.length, 2);
});

test('plain MIME alternative remains preferred over converted HTML', async () => {
  const q = mockQueue(auth, { Body: { GetMsgResponse: { m: [{ id: '1', mp: [{ ct: 'multipart/alternative', mp: [
    { ct: 'text/html', content: '<p>HTML alternative</p>' }, { ct: 'text/plain', content: 'Plain alternative' },
  ] }] }] } } });
  const r = await (await handle(call('zimbra_get_message', { id: '1' }), ENV, q.fetcher)).json();
  assert.equal(r.result.structuredContent.body, 'Plain alternative');
  assert.equal(r.result.structuredContent.body_format, 'plain');
});

test('discarded HTML truncation does not mark a complete plain-text body truncated', async () => {
  const q = mockQueue(auth, { Body: { GetMsgResponse: { m: [{ id: '1', mp: [
    { ct: 'text/plain', content: 'Complete plain body' },
    { ct: 'text/html', content: '<p>' + 'a'.repeat(101000) + '</p>', truncated: true },
  ] }] } } });
  const r = await (await handle(call('zimbra_get_message', { id: '1' }), ENV, q.fetcher)).json();
  assert.equal(r.result.structuredContent.body, 'Complete plain body');
  assert.equal(r.result.structuredContent.body_truncated, false);
});

test('expired token causes exactly one safe read retry; tokens do not reach output', async () => {
  const q = mockQueue(auth, { data: fault('service.AUTH_EXPIRED'), status: 500 }, auth, { Body: { GetTagResponse: {} } });
  const result = await (await handle(call('zimbra_list_tags', {}), ENV, q.fetcher)).json();
  assert.equal(result.result.isError, false); assert.equal(q.calls.length, 4);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  const repeated = mockQueue(auth, fault('service.AUTH_REQUIRED'), auth, fault('service.AUTH_REQUIRED'));
  const failed = await (await handle(call('zimbra_list_tags', {}), ENV, repeated.fetcher)).json();
  assert.equal(repeated.calls.length, 4); assert.equal(failed.result.isError, true);
});

test('faults and exceptions cannot disclose server-controlled error text or secrets', async () => {
  for (const failure of [{ data: fault('account.AUTH_FAILED'), status: 500 }, new Error(`${ENV.ZIMBRA_PASSWORD} ${TOKEN}`),
    { Body: { Fault: { Detail: { Error: { Code: ENV.ZIMBRA_PASSWORD } } } } }]) {
    const q = mockQueue(failure);
    const r = await (await handle(call('zimbra_list_tags', {}), ENV, q.fetcher)).json();
    assert.equal(r.result.isError, true);
    assert.equal(JSON.stringify(r).includes(ENV.ZIMBRA_PASSWORD), false); assert.equal(JSON.stringify(r).includes(TOKEN), false);
  }
});

test('malformed upstream JSON, missing secrets and unusable tokens return controlled errors', async () => {
  for (const [env, fetcher] of [[{ ...ENV, ZIMBRA_PASSWORD: '' }, () => assert.fail()],
    [ENV, async () => new Response('<html>bad gateway</html>')],
    [ENV, async () => response({ Body: { AuthResponse: { authToken: 'invalid\r\ncookie' } } })]]) {
    const result = await (await handle(call('zimbra_list_tags', {}), env, fetcher)).json();
    assert.equal(result.result.isError, true);
  }
});

test('argument schema rejects mutation injection, huge input, malformed IDs, and invalid pages', async () => {
  for (const [name, args] of [['zimbra_search_messages', { query: 'x', read: true }], ['zimbra_search_messages', { query: 'x', limit: 51 }],
    ['zimbra_search_messages', { query: 'x', offset: -1 }], ['zimbra_search_messages', { query: 'x'.repeat(2049) }],
    ['zimbra_get_message', { id: '../file' }], ['zimbra_get_message', { id: '1,2' }], ['zimbra_get_message', []],
    ['zimbra_list_folders', { path: null }], ['zimbra_search_messages', { query: 'x', limit: null }]]) {
    const r = await (await handle(call(name, args), ENV, () => assert.fail('no fetch'))).json();
    assert.equal(r.error.code, -32602);
  }
});

test('endpoint accepts only configured HTTPS public hostname standard SOAP route', () => {
  assert.equal(soapEndpoint('https://zimbra.example/service/soap/'), 'https://zimbra.example/service/soap');
  for (const url of ['http://example.org', 'https://user:pw@example.org', 'https://example.org?token=x', 'https://example.org#x',
    'https://example.org/other', 'https://example.org:8080', 'https://localhost', 'https://127.0.0.1', 'https://[::1]']) {
    assert.throws(() => soapEndpoint(url));
  }
});

test('MCP initialization, notification, methods, versions and body limits', async () => {
  const i = await (await handle(req('initialize', { protocolVersion: '2025-06-18' }))).json();
  assert.equal(i.result.protocolVersion, '2025-06-18');
  const notification = req('notifications/initialized', {}, {}, { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal((await handle(notification)).status, 202);
  assert.equal((await handle(new Request('https://reader.example/mcp'))).status, 405);
  assert.equal((await handle(req('ping', {}, { 'MCP-Protocol-Version': 'future' }))).status, 400);
  assert.equal((await handle(req('tools/list', {}, { Origin: 'https://evil.invalid' }))).status, 403);
  assert.equal((await handle(req('ping', {}, {}, { body: '[' }))).status, 400);
  assert.equal((await handle(req('ping', {}, {}, { body: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await handle(req('ping', {}, {}, { body: '[{}]' }))).status, 400);
});

test('response body is bounded even when content length is absent', async () => {
  const r = await (await handle(call('zimbra_list_tags', {}), ENV, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)))).json();
  assert.match(r.result.content[0].text, /RESPONSE_TOO_LARGE/);
});

test('reader exposes no raw SOAP or mutation method', () => {
  assert.deepEqual(Object.getOwnPropertyNames(ZimbraReader.prototype).sort(), ['constructor', 'folders', 'message', 'search', 'tags']);
});
