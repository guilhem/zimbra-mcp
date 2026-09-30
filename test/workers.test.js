import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const bindings = { MCP_AUTH_MODE: 'sites', MCP_ALLOWED_USER_ID: 'worker-fixture-owner',
  ZIMBRA_URL: 'https://fixture.invalid', ZIMBRA_USER: 'fixture@example.org', ZIMBRA_PASSWORD: 'fixture-not-real' };
const auth = { Body: { AuthResponse: { authToken: [{ _content: 'fixture-token' }] } } };

function runtime(t, outboundService) {
  const mf = new Miniflare({ rootPath, modulesRoot: rootPath, modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-07-18', scriptPath: 'dist/server/index.js', bindings, outboundService });
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
