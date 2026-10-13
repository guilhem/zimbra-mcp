import { SafeError, ZimbraReader } from './zimbra.js';

const id = { type: 'string', minLength: 1, maxLength: 20, pattern: '^[1-9][0-9]{0,19}$', description: 'Local mailbox item ID from a read tool; shared-account IDs are not supported.' };
const ids = { type: 'array', items: id, minItems: 1, maxItems: 50, uniqueItems: true };
const short = description => ({ type: 'string', description, minLength: 1, maxLength: 255, pattern: '^[^\\r\\n\\t\\/\\\\]+$' });
const address = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$', description: 'One explicit bare email address. No display names, groups, or inferred recipients.' };
const recipients = { type: 'array', items: address, minItems: 0, maxItems: 50, uniqueItems: true };
const compose = {
  to: recipients, cc: recipients, bcc: recipients,
  subject: { type: 'string', minLength: 0, maxLength: 998, pattern: '^[^\\r\\n]*$' },
  body: { type: 'string', minLength: 0, maxLength: 50000, description: 'Complete plain-text body. HTML and attachments are not supported.' },
};
const input = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const annotation = (destructive, idempotent = false) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: true });
const tool = (name, description, properties, required, destructive = true, idempotent = false) => ({ name, description, inputSchema: input(properties, required), annotations: annotation(destructive, idempotent) });
const sendUid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', minLength: 36, maxLength: 36, description: 'Fresh UUID v4 for this exact authorized send. Never reuse for different content. A timeout is ambiguous: inspect Sent before any further action; never automatically retry.' };
export const WRITE_TOOLS = Object.freeze([
  tool('zimbra_send_message', 'Send one authorized plain-text email, or reply to a specific original message. Explicit To/Cc/Bcc arrays and full content are required; never infer reply recipients. reply_to_message_id adds original threading. No automatic retry. A send can have irreversible consequences.', { ...compose, send_uid: sendUid, reply_to_message_id: id }, ['to', 'cc', 'bcc', 'subject', 'body', 'send_uid']),
  tool('zimbra_save_draft', 'Create a plain-text draft, or replace a draft using draft_id and expected_modseq from get_message. Replacement requires a current complete plain-text draft, rejects concurrent changes atomically, and refuses HTML, attachments, reply/forward, scheduled, receipt-request or alternate-identity metadata. Never sends.', { ...compose, draft_id: id, expected_modseq: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[0-9]+$' } }, ['to', 'cc', 'bcc', 'subject', 'body']),
  tool('zimbra_delete_draft', 'Move one verified draft to Trash. Recoverable subject to server retention; no permanent purge. Requires the exact authorized draft ID.', { draft_id: id }, ['draft_id']),
  tool('zimbra_move_messages', 'Move authorized messages to an explicit existing mail folder ID. For archive, first identify or create the intended Archive folder and pass its ID; there is no assumed archive destination. No folder deletion.', { ids, folder_id: id }, ['ids', 'folder_id'], true, true),
  tool('zimbra_trash_messages', 'Move authorized messages to Trash, subject to server retention. Refuses messages already in Trash so repeating the operation cannot become permanent deletion. No purge.', { ids }, ['ids'], true, true),
  tool('zimbra_set_read', 'Set the read/unread state of explicitly authorized messages.', { ids, read: { type: 'boolean' } }, ['ids', 'read'], true, true),
  tool('zimbra_set_flag', 'Set or clear the starred/flagged state of explicitly authorized messages.', { ids, flagged: { type: 'boolean' } }, ['ids', 'flagged'], true, true),
  tool('zimbra_set_tag', 'Add or remove one existing tag on explicitly authorized messages; preserves all other tags.', { ids, tag_id: id, add: { type: 'boolean' } }, ['ids', 'tag_id', 'add'], true, true),
  tool('zimbra_create_folder', 'Create one mail folder under an explicit existing local parent folder. Does not change folder permissions or sharing.', { name: short('New single folder name, without path separators'), parent_id: id }, ['name', 'parent_id'], false),
  tool('zimbra_create_tag', 'Create a mailbox tag for classification. Does not apply it to any messages.', { name: short('New tag name'), color: { type: 'integer', minimum: 0, maximum: 127 } }, ['name'], false),
]);

function invalid(key) { throw new SafeError('INVALID_ARGUMENTS', `Invalid argument: ${key}.`); }
function value(rule, v, key) {
  if (rule.type === 'string' && (typeof v !== 'string' || v.length < rule.minLength || v.length > rule.maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || (rule.pattern && !new RegExp(rule.pattern).test(v)))) invalid(key);
  if (rule.type === 'boolean' && typeof v !== 'boolean') invalid(key);
  if (rule.type === 'integer' && (!Number.isSafeInteger(v) || v < rule.minimum || v > rule.maximum)) invalid(key);
  if (rule.type === 'array') {
    if (!Array.isArray(v) || v.length < rule.minItems || v.length > rule.maxItems || (rule.uniqueItems && new Set(v).size !== v.length)) invalid(key);
    for (const entry of v) value(rule.items, entry, key);
  }
}
function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('arguments');
  for (const key of Object.keys(args)) { if (!Object.hasOwn(schema.properties, key)) invalid(key); value(schema.properties[key], args[key], key); }
  for (const key of schema.required) if (!Object.hasOwn(args, key)) invalid(key);
  return args;
}
const list = v => Array.isArray(v) ? v : v == null ? [] : [v];
const first = v => list(v)[0];
const plain = v => typeof v === 'object' ? v?._content : v;
function composeMessage(a) {
  const all = [...a.to, ...a.cc, ...a.bcc];
  if (all.length > 100 || new Set(all.map(a => a.toLowerCase())).size !== all.length) invalid('recipients');
  return { e: ['to', 'cc', 'bcc'].flatMap((key, i) => a[key].map(address => ({ t: ['t', 'c', 'b'][i], a: address }))),
    su: { _content: a.subject }, mp: [{ ct: 'text/plain', content: { _content: a.body } }] };
}
async function get(client, id) {
  const m = first((await client.message(id)).m);
  if (!m || String(m.id) !== id) throw new SafeError('MESSAGE_NOT_FOUND', 'The requested local message was not returned.');
  return m;
}
function requireDraft(m) {
  if (!String(m.f ?? '').includes('d')) throw new SafeError('NOT_A_DRAFT', 'The selected message is not a draft.');
}
function requirePlainDraft(m, env) {
  const unsupported = () => { throw new SafeError('DRAFT_CONTENT_UNSUPPORTED', 'This draft has content, delivery settings or reply/identity metadata that this plain-text tool cannot preserve. Edit it in Zimbra.'); };
  // Rebuilding a draft must not silently cancel scheduled sending, discard reply
  // threading or switch a delegated identity. GetMsg exposes these draft fields.
  for (const key of ['origid', 'rt', 'idnt', 'forAcct', 'irt']) if (plain(m[key]) != null && String(plain(m[key])) !== '') unsupported();
  if ((m.autoSendTime != null && String(m.autoSendTime) !== '0') || [true, 1, '1', 'true'].includes(m.deliveryReport) || m.truncated) unsupported();
  for (const e of list(m.e)) {
    if (['r', 's'].includes(e.t) || (e.t === 'f' && String(e.a).toLowerCase() !== String(env.ZIMBRA_USER).toLowerCase())) unsupported();
  }
  if (!list(m.mp).length) unsupported();
  let count = 0; let plainParts = 0;
  function visit(p, depth = 0) {
    if (!p || typeof p !== 'object' || p.truncated || depth > 15 || ++count > 200 || p.filename || p.cd === 'attachment' || !['text/plain', 'multipart/mixed', 'multipart/alternative'].includes(p.ct)) {
      throw new SafeError('DRAFT_CONTENT_UNSUPPORTED', 'This draft contains content that cannot safely be replaced by this plain-text tool. Edit it in Zimbra.');
    }
    if (p.ct === 'text/plain') plainParts++;
    for (const child of list(p.mp)) visit(child, depth + 1);
  }
  for (const part of list(m.mp)) visit(part);
  if (!plainParts) unsupported();
}
function changed(data, expected, fallback) {
  const node = first(data[expected]);
  if (!node || typeof node !== 'object' || node.id == null) throw new SafeError('WRITE_OUTCOME_UNKNOWN', 'Zimbra did not return the changed item identifiers. Check the mailbox; do not repeat the write automatically.');
  const result = { completed: true, ...fallback };
  if (fallback.ids) {
    const affected = String(node.id).split(',');
    result.affected_ids = affected;
    result.completed = affected.length === fallback.ids.length && fallback.ids.every(id => affected.includes(id));
    if (!result.completed) result.note = 'The response did not confirm every requested item. Check each item before taking further action.';
  }
  for (const key of ['id', 'l', 'rev', 'ms', 'cid', 'op', 'name']) if (node?.[key] != null) result[key] = String(node[key]).slice(0, 255);
  return result;
}
async function requireFolder(client, id, parent = false) {
  const folder = first((await client.folder(id)).folder);
  if (!folder || String(folder.id) !== id || folder.zid || folder.owner || (String(folder.view ?? '') !== 'message' && !(parent && id === '1'))) {
    throw new SafeError('FOLDER_UNSUPPORTED', 'Choose an existing local mail folder. Shared, virtual and non-mail folders are not supported.');
  }
}
async function trash(client, ids, draftOnly = false) {
  // Avoid Zimbra's potentially destructive repeat-trash behavior. Inspect all
  // targets before any mutation; only the explicit Trash folder move is sent.
  for (const id of ids) {
    const m = await get(client, id);
    if (draftOnly) requireDraft(m);
    if (String(m.l) === '3') throw new SafeError('ALREADY_IN_TRASH', 'A selected message is already in Trash. No messages were changed.');
  }
  return client.moveMessages(ids, '3');
}

// Defense in depth only: isolate memory is not durable and is not an exactly-once
// guarantee. Zimbra suid also has a bounded, process-local cache. Never auto-retry.
const sends = new Map();
async function reserveSend(env, uid) {
  const bytes = new TextEncoder().encode(`${env.ZIMBRA_URL}\n${env.ZIMBRA_USER}\n${uid}`);
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  for (const [k, until] of sends) if (until <= now) sends.delete(k);
  if (sends.has(key)) throw new SafeError('SEND_UID_REUSED', 'This send identifier was already attempted. Check Sent; do not automatically retry or use a new identifier to bypass this check.');
  if (sends.size >= 1000) throw new SafeError('SEND_GUARD_FULL', 'Send protection is at capacity. Try later only after checking the mailbox.');
  sends.set(key, now + 24 * 60 * 60 * 1000);
}

export async function callWriteTool(name, args, env, fetchImpl) {
  if (env.ZIMBRA_WRITE_ENABLED !== 'true') throw new SafeError('WRITE_DISABLED', 'Mailbox writes are disabled by the owner.');
  const tool = WRITE_TOOLS.find(t => t.name === name);
  if (!tool) throw new SafeError('UNKNOWN_TOOL', 'Unknown or disabled tool.');
  const a = validate(tool.inputSchema, args);
  const client = new ZimbraReader(env, fetchImpl);
  let result;
  switch (name) {
    case 'zimbra_send_message': {
      const m = composeMessage(a);
      if (!m.e.length) invalid('recipients');
      if (a.reply_to_message_id) {
        const original = await get(client, a.reply_to_message_id);
        const mid = plain(original.mid);
        if (typeof mid !== 'string' || !mid || mid.length > 998 || /[\r\n\u0000-\u001f]/.test(mid)) throw new SafeError('REPLY_THREAD_UNAVAILABLE', 'Original Message-ID is unavailable; reply safely in Zimbra.');
        m.origid = a.reply_to_message_id; m.rt = 'r'; m.irt = { _content: mid };
      }
      await reserveSend(env, a.send_uid);
      result = changed(await client.sendMessage(m, a.send_uid), 'm', { send_uid: a.send_uid });
      break;
    }
    case 'zimbra_save_draft': {
      const m = composeMessage(a);
      if (a.expected_modseq !== undefined && Number(a.expected_modseq) > 2147483647) invalid('expected_modseq');
      if (!!a.draft_id !== !!a.expected_modseq) invalid('draft_id/expected_modseq');
      if (a.draft_id) {
        const original = await get(client, a.draft_id); requireDraft(original); requirePlainDraft(original, env);
        if (String(original.ms) !== a.expected_modseq) throw new SafeError('DRAFT_CHANGED', 'The draft modification sequence changed. Read it again before replacing it.');
        m.id = a.draft_id;
      }
      result = changed(await client.saveDraft(m, a.expected_modseq), 'm', {}); break;
    }
    case 'zimbra_delete_draft': result = changed(await trash(client, [a.draft_id], true), 'action', { ids: [a.draft_id], destination_folder_id: '3', recoverable: true }); break;
    case 'zimbra_trash_messages': result = changed(await trash(client, a.ids), 'action', { ids: a.ids, destination_folder_id: '3', recoverable: true }); break;
    case 'zimbra_move_messages':
      if (['1', '3', '4', '5'].includes(a.folder_id)) invalid('folder_id: use a normal mail folder; use trash_messages for Trash');
      await requireFolder(client, a.folder_id);
      result = changed(await client.moveMessages(a.ids, a.folder_id), 'action', { ids: a.ids, destination_folder_id: a.folder_id }); break;
    case 'zimbra_set_read': result = changed(await client.setRead(a.ids, a.read), 'action', { ids: a.ids, read: a.read }); break;
    case 'zimbra_set_flag': result = changed(await client.setFlag(a.ids, a.flagged), 'action', { ids: a.ids, flagged: a.flagged }); break;
    case 'zimbra_set_tag': result = changed(await client.setTag(a.ids, a.tag_id, a.add), 'action', { ids: a.ids, tag_id: a.tag_id, added: a.add }); break;
    case 'zimbra_create_folder': await requireFolder(client, a.parent_id, true); result = changed(await client.createFolder(a.name, a.parent_id), 'folder', {}); break;
    case 'zimbra_create_tag': result = changed(await client.createTag(a.name, a.color), 'tag', {}); break;
    default: throw new SafeError('UNKNOWN_TOOL', 'Unknown or disabled tool.');
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}
