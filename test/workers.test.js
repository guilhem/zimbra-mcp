import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const bindings = { MCP_AUTH_MODE: 'sites', MCP_ALLOWED_USER_ID: 'worker-fixture-owner',
  ZIMBRA_URL: 'https://fixture.invalid', ZIMBRA_USER: 'fixture@example.org', ZIMBRA_PASSWORD: 'fixture-not-real' };
const auth = { Body: { AuthResponse: { authToken: [{ _content: 'fixture-token' }] } } };

function runtime(t, outboundService, extraBindings = {}) {
  const mf = new Miniflare({ rootPath, modulesRoot: rootPath, modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-07-18', scriptPath: 'dist/server/index.js', bindings: { ...bindings, ...extraBindings }, outboundService });
  t.after(() => mf.dispose());
  return mf;
}
async function invoke(mf, name, args = {}, authenticated = true) {
  const response = await mf.dispatchFetch('http://localhost/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'oai-authenticated-user-id': bindings.MCP_ALLOWED_USER_ID } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return { status: response.status, body: await response.json() };
}

test('workerd: full adapter authenticates and reads through native fetch without changing flags', async t => {
  const calls = [];
  const mf = runtime(t, async request => {
    assert.equal(request.url, 'https://fixture.invalid/service/soap');
    const { Body } = await request.json();
    calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    assert.equal(request.headers.get('Cookie'), 'ZM_AUTH_TOKEN=fixture-token');
    if (Body.GetTagRequest) return Response.json({ Body: { GetTagResponse: { tag: [{ id: '1', name: 'Fixture' }] } } });
    if (Body.SearchRequest) {
      assert.equal(Body.SearchRequest.read, false);
      assert.equal(Body.SearchRequest.fetch, 'none');
      return Response.json({ Body: { SearchResponse: { m: [{ id: '1', su: 'Fixture' }] } } });
    }
    if (Body.GetMsgRequest) {
      assert.equal(Body.GetMsgRequest.m.read, false);
      return Response.json({ Body: { GetMsgResponse: { m: [{ id: '1', mp: [{ ct: 'text/plain', content: 'Fixture body' }] }] } } });
    }
    if (Body.GetFolderRequest) return Response.json({ Body: { GetFolderResponse: { folder: [{ id: '1', name: 'Root' }] } } });
    assert.fail('Unexpected SOAP operation');
  });
  for (const [tool, args] of [['zimbra_list_tags', {}], ['zimbra_search_messages', { query: 'in:inbox' }],
    ['zimbra_get_message', { id: '1' }], ['zimbra_list_folders', {}]]) {
    const r = await invoke(mf, tool, args);
    assert.equal(r.status, 200);
    assert.equal(r.body.result.isError, false, JSON.stringify(r.body));
  }
  assert.deepEqual(calls, ['AuthRequest', 'GetTagRequest', 'AuthRequest', 'SearchRequest',
    'AuthRequest', 'GetMsgRequest', 'AuthRequest', 'GetFolderRequest']);
});

test('workerd: manual redirect mode rejects redirects without forwarding credentials', async t => {
  let calls = 0;
  const mf = runtime(t, () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://unapproved.invalid' } }); });
  const r = await invoke(mf, 'zimbra_list_tags');
  assert.equal(calls, 1);
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /UPSTREAM_REDIRECT_BLOCKED/);
});

test('workerd: unauthenticated calls cannot reach the upstream', async t => {
  let calls = 0;
  const mf = runtime(t, () => { calls++; return new Response('should not happen'); });
  const r = await invoke(mf, 'zimbra_list_tags', {}, false);
  assert.equal(r.status, 401);
  assert.equal(calls, 0);
});

test('workerd: deployed bundle extracts HTML-only text with no resource fetch', async t => {
  let calls = 0;
  const mf = runtime(t, async request => {
    calls++;
    assert.equal(request.url, 'https://fixture.invalid/service/soap');
    const { Body } = await request.json();
    if (Body.AuthRequest) return Response.json(auth);
    assert.equal(Body.GetMsgRequest.m.read, false);
    return Response.json({ Body: { GetMsgResponse: { m: [{ id: '1', mp: [{ ct: 'text/html',
      content: '<p>Fixture HTML &amp; text</p><img src="https://tracking.invalid/pixel"><script>HIDDEN_SCRIPT</script>' }] }] } } });
  });
  const r = await invoke(mf, 'zimbra_get_message', { id: '1' });
  assert.equal(r.body.result.isError, false);
  assert.equal(r.body.result.structuredContent.body, 'Fixture HTML & text');
  assert.equal(r.body.result.structuredContent.body_format, 'html_text');
  assert.equal(calls, 2);
});

test('workerd: enabled writes send exact plain-text payload once; duplicate UUID is blocked', async t => {
  const calls = [];
  const args = { to: ['recipient@example.org'], cc: [], bcc: [], subject: 'Fixture subject', body: 'Fixture body', send_uid: '56baf903-126d-4e0a-9a91-ddf5dca2484b' };
  const mf = runtime(t, async request => {
    assert.equal(request.url, 'https://fixture.invalid/service/soap');
    const { Body } = await request.json(); calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    assert.equal(request.headers.get('Cookie'), 'ZM_AUTH_TOKEN=fixture-token');
    assert.deepEqual(Body.SendMsgRequest, { _jsns: 'urn:zimbraMail', suid: args.send_uid,
      m: { e: [{ t: 't', a: args.to[0] }], su: { _content: args.subject }, mp: [{ ct: 'text/plain', content: { _content: args.body } }] } });
    return Response.json({ Body: { SendMsgResponse: { m: [{ id: '51' }] } } });
  }, { ZIMBRA_WRITE_ENABLED: 'true' });
  const result = await invoke(mf, 'zimbra_send_message', args); assert.equal(result.body.result.isError, false);
  const duplicate = await invoke(mf, 'zimbra_send_message', args); assert.match(duplicate.body.result.content[0].text, /SEND_UID_REUSED/);
  assert.deepEqual(calls, ['AuthRequest', 'SendMsgRequest']);
});

test('workerd: enabled writes still enforce owner authentication and schema before fetch', async t => {
  let calls = 0;
  const mf = runtime(t, () => { calls++; assert.fail('must not contact upstream'); }, { ZIMBRA_WRITE_ENABLED: 'true' });
  assert.equal((await invoke(mf, 'zimbra_set_read', { ids: ['42'], read: true }, false)).status, 401);
  assert.equal((await invoke(mf, 'zimbra_set_read', { ids: ['42'], read: 'true' })).body.error.code, -32602);
  assert.equal(calls, 0);
});

test('workerd: writes remain disabled unless explicitly enabled', async t => {
  let calls = 0;
  const mf = runtime(t, () => { calls++; assert.fail('must not contact upstream'); });
  const r = await invoke(mf, 'zimbra_set_read', { ids: ['42'], read: true });
  assert.equal(r.body.error.code, -32602); assert.equal(calls, 0);
});

test('workerd: auth expiry on mutation does not trigger the safe-read retry path', async t => {
  const calls = [];
  const mf = runtime(t, async request => {
    const { Body } = await request.json(); calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    return Response.json({ Body: { Fault: { Detail: { Error: { Code: 'service.AUTH_EXPIRED' } }, Reason: { Text: 'fixture-token fixture-not-real' } } } });
  }, { ZIMBRA_WRITE_ENABLED: 'true' });
  const r = await invoke(mf, 'zimbra_set_flag', { ids: ['42'], flagged: true });
  assert.equal(r.body.result.isError, true); assert.match(r.body.result.content[0].text, /service.AUTH_EXPIRED/);
  assert.doesNotMatch(JSON.stringify(r.body), /fixture-token|fixture-not-real/);
  assert.deepEqual(calls, ['AuthRequest', 'MsgActionRequest']);
});

test('workerd: draft update carries server-enforced modification sequence', async t => {
  const calls = [];
  const mf = runtime(t, async request => {
    const { Header, Body } = await request.json(); calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    if (Body.GetMsgRequest) {
      assert.equal(Body.GetMsgRequest.m.wantModSeq, true); assert.equal(Body.GetMsgRequest.m.read, false);
      return Response.json({ Body: { GetMsgResponse: { m: [{ id: '42', f: 'd', ms: '9', mp: [{ ct: 'text/plain' }] }] } } });
    }
    assert.deepEqual(Header.context.change, { token: '9', type: 'mod' });
    assert.equal(Body.SaveDraftRequest.m.id, '42');
    return Response.json({ Body: { SaveDraftResponse: { m: [{ id: '42', ms: '10' }] } } });
  }, { ZIMBRA_WRITE_ENABLED: 'true' });
  const r = await invoke(mf, 'zimbra_save_draft', { to: [], cc: [], bcc: [], subject: 'Draft', body: 'Body', draft_id: '42', expected_modseq: '9' });
  assert.equal(r.body.result.isError, false);
  assert.deepEqual(calls, ['AuthRequest', 'GetMsgRequest', 'AuthRequest', 'SaveDraftRequest']);
});

test('workerd: repeat trash is refused after read-only preflight', async t => {
  const calls = [];
  const mf = runtime(t, async request => {
    const { Body } = await request.json(); calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    assert.ok(Body.GetMsgRequest);
    return Response.json({ Body: { GetMsgResponse: { m: [{ id: '42', l: '3' }] } } });
  }, { ZIMBRA_WRITE_ENABLED: 'true' });
  const r = await invoke(mf, 'zimbra_trash_messages', { ids: ['42'] });
  assert.match(r.body.result.content[0].text, /ALREADY_IN_TRASH/);
  assert.deepEqual(calls, ['AuthRequest', 'GetMsgRequest']);
});
