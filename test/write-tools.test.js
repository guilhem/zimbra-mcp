import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handle } from '../src/worker.js';
import { WRITE_TOOLS, callWriteTool } from '../src/write-tools.js';
import { ZimbraReader } from '../src/zimbra.js';

const env = { MCP_AUTH_MODE: 'sites', MCP_ALLOWED_USER_ID: 'write-fixture-owner', ZIMBRA_WRITE_ENABLED: 'true',
  ZIMBRA_URL: 'https://write-fixture.invalid', ZIMBRA_USER: 'owner@example.org', ZIMBRA_PASSWORD: 'WRITE_TEST_PASSWORD' };
const token = 'WRITE_TEST_TOKEN';
const auth = { Body: { AuthResponse: { authToken: token } } };
const soap = (name, value) => ({ Body: { [name + 'Response']: value } });
const original = (m = {}) => soap('GetMsg', { m: [{ id: '42', l: '2', mid: '<original@example.org>', ...m }] });
const draft = (m = {}) => original({ f: 'd', rev: '7', ms: '7', mp: [{ ct: 'text/plain', content: 'old' }], ...m });
const compose = () => ({ to: ['to@example.org'], cc: ['cc@example.org'], bcc: ['bcc@example.org'], subject: 'Exact subject', body: 'Exact body\nSecond line' });
const send = () => ({ ...compose(), send_uid: randomUUID() });
function queue(...responses) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    assert.ok(responses.length, 'Unexpected upstream call');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  } };
}
async function invoke(name, args, q, config = env, identity = env.MCP_ALLOWED_USER_ID) {
  const r = await handle(new Request('https://adapter.invalid/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(identity ? { 'oai-authenticated-user-id': identity } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), config, q.fetch);
  return { status: r.status, ...(await r.json()) };
}
const operation = q => q.calls.map(c => Object.keys(c.body.Body)[0]);
const errorCode = (r, code) => { assert.equal(r.result?.isError, true, JSON.stringify(r)); assert.match(r.result.content[0].text, new RegExp(code)); };

test('write discovery requires exact owner enablement; schemas explicitly annotate all mutations', async () => {
  for (const enabled of [undefined, false, true, 'TRUE', 'false', 'true']) {
    const r = await handle(new Request('https://adapter.invalid/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), { ...env, ZIMBRA_WRITE_ENABLED: enabled });
    assert.equal((await r.json()).result.tools.length, enabled === 'true' ? 14 : 4);
  }
  assert.equal(WRITE_TOOLS.length, 10);
  for (const tool of WRITE_TOOLS) { assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.inputSchema.additionalProperties, false); }
});

test('every write is owner-gated and disabled client/tool entry points fail before fetch', async () => {
  const q = queue();
  for (const tool of WRITE_TOOLS) {
    for (const [identity, status] of [[null, 401], ['other-owner', 403]]) assert.equal((await invoke(tool.name, {}, q, env, identity)).status, status);
    await assert.rejects(callWriteTool(tool.name, {}, { ...env, ZIMBRA_WRITE_ENABLED: 'false' }, q.fetch), { code: 'WRITE_DISABLED' });
  }
  await assert.rejects(new ZimbraReader({ ...env, ZIMBRA_WRITE_ENABLED: false }, q.fetch).sendMessage({}, randomUUID()), { code: 'WRITE_DISABLED' });
  assert.equal(q.calls.length, 0);
});

test('send transmits only exact explicit recipients and plain content with mandatory UUID', async () => {
  const a = send(); const q = queue(auth, soap('SendMsg', { m: [{ id: '81', cid: '12', secret: token }] }));
  const r = await invoke('zimbra_send_message', a, q);
  assert.equal(r.result.isError, false);
  assert.deepEqual(operation(q), ['AuthRequest', 'SendMsgRequest']);
  assert.deepEqual(q.calls[1].body.Body.SendMsgRequest, { _jsns: 'urn:zimbraMail', suid: a.send_uid, m: {
    e: [{ t: 't', a: 'to@example.org' }, { t: 'c', a: 'cc@example.org' }, { t: 'b', a: 'bcc@example.org' }],
    su: { _content: a.subject }, mp: [{ ct: 'text/plain', content: { _content: a.body } }] } });
  assert.equal(r.result.structuredContent.id, '81');
  assert.doesNotMatch(JSON.stringify(r), /WRITE_TEST_TOKEN|WRITE_TEST_PASSWORD/);
});

test('successful sends without a saved copy need no message ID and still reserve the UUID', async () => {
  for (const m of [{}, [{}]]) {
    const a = send(); const q = queue(auth, soap('SendMsg', { m }));
    const r = await invoke('zimbra_send_message', a, q);
    assert.equal(r.result.isError, false);
    assert.deepEqual(r.result.structuredContent, { completed: true, send_uid: a.send_uid });
    assert.deepEqual(operation(q), ['AuthRequest', 'SendMsgRequest']);
    const unused = queue(); errorCode(await invoke('zimbra_send_message', a, unused), 'SEND_UID_REUSED');
    assert.equal(unused.calls.length, 0);
  }
});

test('missing or malformed send messages and ID-less drafts remain ambiguous', async () => {
  for (const m of [undefined, null, [], '', 'invalid', 1, [{}, {}], [{}, { id: '42' }]]) {
    const q = queue(auth, soap('SendMsg', { m }));
    errorCode(await invoke('zimbra_send_message', send(), q), 'WRITE_OUTCOME_UNKNOWN');
    assert.equal(q.calls.length, 2);
  }
  const q = queue(auth, soap('SaveDraft', { m: [{}] }));
  errorCode(await invoke('zimbra_save_draft', compose(), q), 'WRITE_OUTCOME_UNKNOWN');
});

test('ID-less send success requires an empty message node', async () => {
  for (const node of [{ id: null }, { error: 'unexpected' }, { cid: '12' }, { secret: token }]) {
    for (const m of [node, [node]]) {
      const q = queue(auth, soap('SendMsg', { m }));
      const r = await invoke('zimbra_send_message', send(), q);
      errorCode(r, 'WRITE_OUTCOME_UNKNOWN');
      assert.equal(q.calls.length, 2);
      assert.doesNotMatch(JSON.stringify(r), /WRITE_TEST_TOKEN/);
    }
  }
});

test('write confirmations reject malformed identifiers and shapes and accept scalar IDs', async () => {
  const operations = [
    ['zimbra_send_message', send, 'SendMsg', 'm', []],
    ['zimbra_save_draft', compose, 'SaveDraft', 'm', []],
    ['zimbra_create_folder', () => ({ name: 'Example', parent_id: '1' }), 'CreateFolder', 'folder', [auth, soap('GetFolder', { folder: { id: '1' } })]],
    ['zimbra_create_tag', () => ({ name: 'Example' }), 'CreateTag', 'tag', []],
    ['zimbra_set_read', () => ({ ids: ['42'], read: true }), 'MsgAction', 'action', []],
  ];
  for (const [name, args, op, field, preflight] of operations) {
    for (const id of ['', false, {}, [], null, '0', '01', 'invalid', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const q = queue(...preflight, auth, soap(op, { [field]: { id } }));
      errorCode(await invoke(name, args(), q), 'WRITE_OUTCOME_UNKNOWN');
    }
    for (const value of [[{ id: '42' }, {}], [{ id: '42' }, { id: '43' }], [[{ id: '42' }]], []]) {
      const q = queue(...preflight, auth, soap(op, { [field]: value }));
      errorCode(await invoke(name, args(), q), 'WRITE_OUTCOME_UNKNOWN');
    }
    for (const value of [{ id: 42 }, [{ id: 42 }]]) {
      const q = queue(...preflight, auth, soap(op, { [field]: value }));
      const r = await invoke(name, args(), q);
      assert.equal(r.result.isError, false); assert.equal(r.result.structuredContent.id, '42');
    }
  }
  for (const id of ['42,,43', '42,invalid', '42,0', Array(51).fill('42').join(',')]) {
    const q = queue(auth, soap('MsgAction', { action: { id } }));
    errorCode(await invoke('zimbra_set_read', { ids: ['42'], read: true }, q), 'WRITE_OUTCOME_UNKNOWN');
  }
  const q = queue(auth, soap('SaveDraft', { m: { id: '42,43' } }));
  errorCode(await invoke('zimbra_save_draft', compose(), q), 'WRITE_OUTCOME_UNKNOWN');
  const ids = Array.from({ length: 50 }, (_, i) => String(i + 1));
  const batch = queue(auth, soap('MsgAction', { action: { id: ids.join(',') } }));
  const r = await invoke('zimbra_set_read', { ids, read: true }, batch);
  assert.equal(r.result.structuredContent.completed, true); assert.deepEqual(r.result.structuredContent.affected_ids, ids);
});

test('reply reads original without marking read and never infers recipients', async () => {
  const a = { ...send(), to: ['explicit@example.org'], cc: [], bcc: [], reply_to_message_id: '42' };
  const q = queue(auth, original({ e: [{ a: 'unrequested@example.org', t: 'f' }] }), auth, soap('SendMsg', { m: [{ id: '82' }] }));
  const r = await invoke('zimbra_send_message', a, q); assert.equal(r.result.isError, false);
  const m = q.calls[3].body.Body.SendMsgRequest.m;
  assert.equal(q.calls[1].body.Body.GetMsgRequest.m.read, false);
  assert.deepEqual(m.e, [{ t: 't', a: 'explicit@example.org' }]);
  assert.equal(m.origid, '42'); assert.equal(m.rt, 'r'); assert.deepEqual(m.irt, { _content: '<original@example.org>' });
  for (const mid of [null, '', 'bad\r\ninjection']) {
    const bad = queue(auth, original({ mid })); errorCode(await invoke('zimbra_send_message', { ...a, send_uid: randomUUID() }, bad), 'REPLY_THREAD_UNAVAILABLE'); assert.equal(bad.calls.length, 2);
  }
});

test('attempted send UUID cannot be reused after success or ambiguous failure', async () => {
  for (const failure of [false, true]) {
    const a = send(); const q = queue(auth, failure ? new Error(token) : soap('SendMsg', { m: [{ id: '83' }] }));
    const first = await invoke('zimbra_send_message', a, q); if (failure) errorCode(first, 'WRITE_OUTCOME_UNKNOWN');
    const unused = queue(); errorCode(await invoke('zimbra_send_message', a, unused), 'SEND_UID_REUSED'); assert.equal(unused.calls.length, 0);
  }
});

test('writes are never retried for auth expiration, faults, network errors, redirects or malformed responses', async () => {
  for (const failure of [soap('Fault', {}), { Body: { Fault: { Detail: { Error: { Code: 'service.AUTH_EXPIRED' } }, Reason: { Text: token } } } },
    { Body: { Fault: { Detail: { Error: { Code: 'service.AUTH_REQUIRED' } } } } }, new Error(token), new DOMException('timeout', 'AbortError'),
    new Response('not JSON'), new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/' + token } })]) {
    const q = queue(auth, failure); const r = await invoke('zimbra_send_message', send(), q);
    assert.equal(r.result.isError, true); assert.equal(q.calls.length, 2); assert.doesNotMatch(JSON.stringify(r), /WRITE_TEST_TOKEN|WRITE_TEST_PASSWORD/);
  }
  const q = queue({ Body: { Fault: { Detail: { Error: { Code: 'account.AUTH_FAILED' } } } } });
  errorCode(await invoke('zimbra_send_message', send(), q), 'account.AUTH_FAILED'); assert.equal(q.calls.length, 1);
});

test('draft creation allows empty recipients and never sends', async () => {
  const q = queue(auth, soap('SaveDraft', { m: [{ id: '91', rev: '1' }] }));
  const r = await invoke('zimbra_save_draft', { ...compose(), to: [], cc: [], bcc: [] }, q);
  assert.equal(r.result.isError, false); assert.deepEqual(operation(q), ['AuthRequest', 'SaveDraftRequest']);
  assert.deepEqual(q.calls[1].body.Body.SaveDraftRequest.m.e, []);
});

test('draft update verifies ID, draft flag, revision, and MIME content before replacing', async () => {
  const args = { ...compose(), draft_id: '42', expected_modseq: '7' };
  const q = queue(auth, draft(), auth, soap('SaveDraft', { m: [{ id: '42', rev: '8' }] }));
  const r = await invoke('zimbra_save_draft', args, q); assert.equal(r.result.isError, false);
  assert.equal(q.calls[3].body.Body.SaveDraftRequest.m.id, '42');
  assert.equal(q.calls[1].body.Body.GetMsgRequest.m.wantModSeq, true);
  assert.deepEqual(q.calls[3].body.Header.context.change, { token: '7', type: 'mod' });
  for (const [m, code] of [[{ id: '43' }, 'MESSAGE_NOT_FOUND'], [{ f: '' }, 'NOT_A_DRAFT'], [{ ms: '8' }, 'DRAFT_CHANGED'],
    [{ mp: [{ ct: 'text/html' }] }, 'DRAFT_CONTENT_UNSUPPORTED'], [{ mp: [{ ct: 'text/plain', filename: 'attachment.txt' }] }, 'DRAFT_CONTENT_UNSUPPORTED']]) {
    const bad = queue(auth, draft(m)); errorCode(await invoke('zimbra_save_draft', args, bad), code); assert.equal(bad.calls.length, 2);
  }
});

test('draft replacement confirmation must identify the reviewed draft', async () => {
  const args = { ...compose(), draft_id: '42', expected_modseq: '7' };
  for (const id of ['43', 43]) {
    const q = queue(auth, draft(), auth, soap('SaveDraft', { m: [{ id }] }));
    errorCode(await invoke('zimbra_save_draft', args, q), 'WRITE_OUTCOME_UNKNOWN');
    assert.deepEqual(operation(q), ['AuthRequest', 'GetMsgRequest', 'AuthRequest', 'SaveDraftRequest']);
  }
  const q = queue(auth, draft(), auth, soap('SaveDraft', { m: [{ id: 42 }] }));
  const r = await invoke('zimbra_save_draft', args, q);
  assert.equal(r.result.isError, false); assert.equal(r.result.structuredContent.id, '42');
});

test('draft replacement refuses any plain part whose content was not returned', async () => {
  for (const content of [undefined, null, {}, 1]) {
    const incomplete = { mp: [{ ct: 'multipart/alternative', mp: [
      { ct: 'text/plain', content: 'Visible body' }, { ct: 'text/plain', s: 100, content },
    ] }] };
    const q = queue(auth, draft(incomplete), auth, soap('SaveDraft', { m: [{ id: '42' }] }));
    errorCode(await invoke('zimbra_save_draft', { ...compose(), draft_id: '42', expected_modseq: '7' }, q), 'DRAFT_CONTENT_UNSUPPORTED');
    assert.deepEqual(operation(q), ['AuthRequest', 'GetMsgRequest']);
  }
});

test('draft replacement accepts complete plain text including explicit empty content', async () => {
  for (const content of ['', 'Body', { _content: '' }, { _content: 'Body' }]) {
    const q = queue(auth, draft({ mp: [{ ct: 'text/plain', content }] }), auth, soap('SaveDraft', { m: [{ id: '42' }] }));
    const r = await invoke('zimbra_save_draft', { ...compose(), draft_id: '42', expected_modseq: '7' }, q);
    assert.equal(r.result.isError, false);
    assert.deepEqual(operation(q), ['AuthRequest', 'GetMsgRequest', 'AuthRequest', 'SaveDraftRequest']);
  }
});

test('trash preflights every item then uses move to folder 3, never trash/delete/purge', async () => {
  const q = queue(auth, original(), auth, original({ id: '43' }), auth, soap('MsgAction', { action: { id: '42,43', op: 'move' } }));
  const r = await invoke('zimbra_trash_messages', { ids: ['42', '43'] }, q); assert.equal(r.result.isError, false);
  assert.deepEqual(q.calls[5].body.Body.MsgActionRequest.action, { id: '42,43', op: 'move', l: '3' });
  const bad = queue(auth, original(), auth, original({ id: '43', l: '3' }));
  errorCode(await invoke('zimbra_trash_messages', { ids: ['42', '43'] }, bad), 'ALREADY_IN_TRASH'); assert.equal(bad.calls.length, 4);
  const notDraft = queue(auth, original()); errorCode(await invoke('zimbra_delete_draft', { draft_id: '42' }, notDraft), 'NOT_A_DRAFT');
  const good = queue(auth, draft(), auth, soap('MsgAction', { action: { id: '42' } })); assert.equal((await invoke('zimbra_delete_draft', { draft_id: '42' }, good)).result.isError, false);
  assert.deepEqual(good.calls[3].body.Body.MsgActionRequest.action, { id: '42', op: 'move', l: '3' });
});

test('move, read, flag, tag and creation map only allowlisted SOAP operations', async () => {
  const cases = [
    ['zimbra_move_messages', { ids: ['42', '43'], folder_id: '100' }, 'MsgAction', { action: { id: '42,43', op: 'move', l: '100' } }],
    ...[true, false].flatMap(v => [
      ['zimbra_set_read', { ids: ['42'], read: v }, 'MsgAction', { action: { id: '42', op: v ? 'read' : '!read' } }],
      ['zimbra_set_flag', { ids: ['42'], flagged: v }, 'MsgAction', { action: { id: '42', op: v ? 'flag' : '!flag' } }],
      ['zimbra_set_tag', { ids: ['42'], tag_id: '5', add: v }, 'MsgAction', { action: { id: '42', op: v ? 'tag' : '!tag', t: '5' } }]]),
    ['zimbra_create_folder', { name: 'Archive', parent_id: '1' }, 'CreateFolder', { folder: { name: 'Archive', l: '1', view: 'message' } }],
    ['zimbra_create_tag', { name: 'Project', color: 127 }, 'CreateTag', { tag: { name: 'Project', color: 127 } }],
    ['zimbra_create_tag', { name: 'Plain' }, 'CreateTag', { tag: { name: 'Plain' } }],
  ];
  for (const [name, args, op, expected] of cases) {
    const preflight = name === 'zimbra_move_messages' || name === 'zimbra_create_folder';
    const prefix = preflight ? [auth, soap('GetFolder', { folder: [{ id: args.folder_id ?? args.parent_id, view: 'message' }] })] : [];
    const field = op === 'MsgAction' ? 'action' : op === 'CreateFolder' ? 'folder' : 'tag';
    const q = queue(...prefix, auth, soap(op, { [field]: { id: args.ids?.join(',') ?? '101' } })); assert.equal((await invoke(name, args, q)).result.isError, false);
    assert.deepEqual(operation(q), [...(preflight ? ['AuthRequest', 'GetFolderRequest'] : []), 'AuthRequest', op + 'Request']);
    assert.deepEqual(q.calls.at(-1).body.Body[op + 'Request'], { _jsns: 'urn:zimbraMail', ...expected });
  }
});

test('malformed, nested, ambiguous and injected inputs fail before authentication', async () => {
  const a = send();
  const cases = [
    ...[undefined, 'not-a-uuid', '00000000-0000-0000-0000-000000000000'].map(send_uid => ['zimbra_send_message', { ...a, send_uid }]),
    ...[{ to: [] , cc: [], bcc: [] }, { to: ['Display <x@example.org>'] }, { to: ['x@example.org\r\nBcc: y@example.org'] },
      { to: [['nested@example.org']] }, { to: [{ a: 'x@example.org' }] }, { cc: ['TO@example.org'] }, { subject: 'header\r\ninjection' }, { body: 'x'.repeat(50001) },
      { body: 'bad\u0000value' }, { attachments: [] }, { from: 'spoof@example.org' }, { reply_to_message_id: 'a:42' },
      { e: [{ t: 'b', a: 'hidden@example.org' }] }].map(p => ['zimbra_send_message', { ...a, ...p }]),
    ['zimbra_save_draft', { ...compose(), draft_id: '42' }], ['zimbra_save_draft', { ...compose(), expected_modseq: '7' }],
    ...[[], ['42', '42'], ['42,43'], ['a:42'], ['0'], [42], [null], Array(51).fill('42')].map(ids => ['zimbra_set_read', { ids, read: true }]),
    ['zimbra_set_read', { ids: ['42'], read: 'true' }], ['zimbra_set_flag', { ids: ['42'], flagged: null }],
    ['zimbra_set_tag', { ids: ['42'], tag_id: '1,2', add: true }],
    ...['1', '3', '4', '5'].map(folder_id => ['zimbra_move_messages', { ids: ['42'], folder_id }]),
    ...['../Archive', 'A/B', 'A\\B', 'A\nB', ''].map(name => ['zimbra_create_folder', { name, parent_id: '1' }]),
    ...[-1, 128, 1.5, '2'].map(color => ['zimbra_create_tag', { name: 'Tag', color }]),
    ['zimbra_trash_messages', { ids: ['42'], op: 'delete' }], ['zimbra_set_read', []], ['zimbra_set_read', null],
  ];
  for (const [name, args] of cases) { const q = queue(); const r = await invoke(name, args, q); assert.equal(r.error?.code, -32602, JSON.stringify({ name, args, r })); assert.equal(q.calls.length, 0); }
});

test('atomic draft conflict is reported without retrying SaveDraft', async () => {
  const q = queue(auth, draft(), auth, { Body: { Fault: { Detail: { Error: { Code: 'mail.MODIFY_CONFLICT' } } } } });
  errorCode(await invoke('zimbra_save_draft', { ...compose(), draft_id: '42', expected_modseq: '7' }, q), 'mail.MODIFY_CONFLICT');
  assert.deepEqual(operation(q), ['AuthRequest', 'GetMsgRequest', 'AuthRequest', 'SaveDraftRequest']);
});

test('folder preflight rejects mismatched, missing, shared and non-mail destinations before mutation', async () => {
  for (const folder of [null, { id: '101', view: 'message' }, { id: '100', view: 'appointment' }, { id: '100', view: 'message', owner: 'someone@example.org' }, { id: '100', view: 'message', zid: 'shared' }]) {
    const q = queue(auth, soap('GetFolder', { folder: folder ? [folder] : [] }));
    errorCode(await invoke('zimbra_move_messages', { ids: ['42'], folder_id: '100' }, q), 'FOLDER_UNSUPPORTED');
    assert.deepEqual(operation(q), ['AuthRequest', 'GetFolderRequest']);
  }
});

test('missing mutation identifiers are ambiguous and partial batch outcomes are explicit', async () => {
  const missing = queue(auth, soap('MsgAction', {}));
  errorCode(await invoke('zimbra_set_read', { ids: ['42'], read: true }, missing), 'WRITE_OUTCOME_UNKNOWN');
  const partial = queue(auth, soap('MsgAction', { action: { id: '42' } }));
  const r = await invoke('zimbra_set_read', { ids: ['42', '43'], read: true }, partial);
  assert.equal(r.result.structuredContent.completed, false);
  assert.equal(partial.calls.length, 2);
});

test('actual 15-second abort yields uncertain write outcome with no retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let markStarted; const started = new Promise(resolve => { markStarted = resolve; });
  const calls = [];
  const q = { fetch: async (_, options) => {
    const { Body } = JSON.parse(options.body); calls.push(Object.keys(Body)[0]);
    if (Body.AuthRequest) return Response.json(auth);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
      markStarted();
    });
  } };
  const pending = invoke('zimbra_set_read', { ids: ['42'], read: true }, q);
  await started;
  t.mock.timers.tick(15000);
  errorCode(await pending, 'WRITE_OUTCOME_UNKNOWN');
  assert.deepEqual(calls, ['AuthRequest', 'MsgActionRequest']);
});

test('request limit measures UTF-8 bytes and accepts exactly 128 KiB', async () => {
  const prefix = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  for (const [body, expected] of [[prefix + ' '.repeat(128 * 1024 - prefix.length), 200],
    [prefix + ' '.repeat(128 * 1024 - prefix.length + 1), 413], [prefix + 'é'.repeat(65536), 413]]) {
    const r = await handle(new Request('https://adapter.invalid/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), env, () => assert.fail('must not fetch'));
    assert.equal(r.status, expected);
  }
});

test('draft replacement refuses metadata and MIME content it cannot preserve', async () => {
  const cases = [
    { origid: '41' }, { rt: 'r' }, { idnt: 'identity-id' }, { forAcct: 'someone@example.org' },
    { irt: '<thread@example.org>' }, { irt: { _content: '<thread@example.org>' } },
    { autoSendTime: 1700000000000 }, { deliveryReport: true }, { truncated: true },
    { mp: [] }, { mp: undefined }, { mp: [{ ct: 'multipart/mixed', mp: [] }] },
    { mp: [{ ct: 'text/plain', truncated: true }] },
    { mp: [{ ct: 'multipart/mixed', mp: [{ ct: 'text/plain', content: 'Body' }, { ct: 'image/png', filename: 'image.png' }] }] },
    { e: [{ t: 'r', a: 'reply@example.org' }] }, { e: [{ t: 's', a: 'sender@example.org' }] },
    { deliveryReport: false, e: [{ t: 'n', a: 'receipt@example.org' }] }, { f: 'd!' }, { f: 'd?' },
    { e: [{ t: 'f', a: 'alternate@example.org' }] },
  ];
  for (const metadata of cases) {
    const q = queue(auth, draft(metadata), auth, soap('SaveDraft', { m: [{ id: '42' }] })); const r = await invoke('zimbra_save_draft', { ...compose(), draft_id: '42', expected_modseq: '7' }, q);
    errorCode(r, 'DRAFT_CONTENT_UNSUPPORTED'); assert.deepEqual(operation(q), ['AuthRequest', 'GetMsgRequest']);
  }
});
