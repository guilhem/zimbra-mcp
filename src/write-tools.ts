import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SafeError, ZimbraReader, isSoapObject, list, plain } from './zimbra.ts';
import type { Env, FetchImpl, SoapObject } from './zimbra.ts';
import { defineTool } from './tool-definition.ts';

const idPattern = /^[1-9][0-9]{0,19}$/;
const id = z.string().min(1).max(20).regex(idPattern).describe('Local mailbox item ID from a read tool; shared-account IDs are not supported.');
const ids = z.array(id).min(1).max(50).refine(a => new Set(a).size === a.length, 'Item IDs must be unique.').meta({ uniqueItems: true });
const string = (max: number) => z.string().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);
const short = (description: string) => string(255).min(1).regex(/^[^\r\n\t/\\]+$/).describe(description);
const address = string(254).min(3).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/)
  .describe('One explicit bare email address. No display names, groups, or inferred recipients.');
const recipients = z.array(address).max(50).refine(a => new Set(a).size === a.length, 'Recipients must be unique.').meta({ uniqueItems: true });
const compose = {
  to: recipients, cc: recipients, bcc: recipients,
  subject: string(998).regex(/^[^\r\n]*$/),
  body: string(50000).describe('Complete plain-text body. HTML and attachments are not supported.'),
};
type Composition = z.infer<z.ZodObject<typeof compose>>;
function validRecipients(a: Composition): boolean {
  const all = [...a.to, ...a.cc, ...a.bcc];
  return all.length <= 100 && new Set(all.map(address => address.toLowerCase())).size === all.length;
}
const sendUid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .describe('Fresh UUID v4 for this exact authorized send. Never reuse for different content. A timeout is ambiguous: inspect Sent before any further action; never automatically retry.');
const annotation = (destructive: boolean, idempotent = false) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: true });
type ComposedMessage = {
  e: { t: string; a: string }[];
  su: { _content: string };
  mp: { ct: string; content: { _content: string } }[];
  id?: string;
  origid?: string;
  rt?: 'r';
  irt?: { _content: string };
};
function composeMessage(a: Composition): ComposedMessage {
  return { e: [...a.to.map(address => ({ t: 't', a: address })), ...a.cc.map(address => ({ t: 'c', a: address })), ...a.bcc.map(address => ({ t: 'b', a: address }))],
    su: { _content: a.subject }, mp: [{ ct: 'text/plain', content: { _content: a.body } }] };
}
async function get(client: ZimbraReader, id: string): Promise<SoapObject> {
  const value = list((await client.message(id)).m)[0];
  if (!isSoapObject(value) || String(value.id) !== id) throw new SafeError('MESSAGE_NOT_FOUND');
  return value;
}
function requireDraft(m: SoapObject): void {
  if (!String(m.f ?? '').includes('d')) throw new SafeError('NOT_A_DRAFT');
}
function requirePlainDraft(m: SoapObject, env: Env): void {
  function unsupported(): never { throw new SafeError('DRAFT_CONTENT_UNSUPPORTED'); }
  // Rebuilding must preserve delivery, threading, priority and delegated identity.
  for (const key of ['origid', 'rt', 'idnt', 'forAcct', 'irt']) if (plain(m[key]) != null && String(plain(m[key])) !== '') unsupported();
  if (/[!?]/.test(String(m.f ?? ''))) unsupported();
  if ((m.autoSendTime != null && String(m.autoSendTime) !== '0') || [true, 1, '1', 'true'].some(value => value === m.deliveryReport) || m.truncated) unsupported();
  for (const value of list(m.e)) {
    if (!isSoapObject(value)) unsupported();
    if ((typeof value.t === 'string' && ['r', 's', 'n'].includes(value.t)) || (value.t === 'f' && String(value.a).toLowerCase() !== String(env.ZIMBRA_USER).toLowerCase())) unsupported();
  }
  if (!list(m.mp).length) unsupported();
  let count = 0; let plainParts = 0;
  function visit(p: unknown, depth = 0): void {
    if (!isSoapObject(p) || p.truncated || depth > 15 || ++count > 200 || p.filename || p.cd === 'attachment' ||
        (p.ct !== 'text/plain' && p.ct !== 'multipart/mixed' && p.ct !== 'multipart/alternative')) unsupported();
    if (p.ct === 'text/plain') {
      if (typeof plain(p.content) !== 'string') unsupported();
      plainParts++;
    }
    for (const child of list(p.mp)) visit(child, depth + 1);
  }
  for (const part of list(m.mp)) visit(part);
  if (!plainParts) unsupported();
}
function confirmation(value: unknown): SoapObject {
  const nodes = list(value);
  const node = nodes.length === 1 ? nodes[0] : undefined;
  if (!isSoapObject(node)) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
  return node;
}
interface WriteResult extends SoapObject { completed: boolean; id?: string; affected_ids?: string[]; note?: string }
function changed(data: SoapObject, expected: string, fallback: SoapObject & { ids?: string[] }): WriteResult {
  const node = confirmation(data[expected]);
  const identifier = node.id;
  const pattern = fallback.ids ? /^[1-9][0-9]{0,19}(?:,[1-9][0-9]{0,19}){0,49}$/ : idPattern;
  if ((typeof identifier !== 'string' && (typeof identifier !== 'number' || !Number.isSafeInteger(identifier))) || !pattern.test(String(identifier))) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
  const result: WriteResult = { completed: true, ...fallback };
  if (fallback.ids) {
    const affected = String(identifier).split(',');
    result.affected_ids = affected;
    result.completed = affected.length === fallback.ids.length && fallback.ids.every(id => affected.includes(id));
    if (!result.completed) result.note = 'The response did not confirm every requested item. Check each item before taking further action.';
  }
  for (const key of ['id', 'l', 'rev', 'ms', 'cid', 'op', 'name']) if (node[key] != null) result[key] = String(node[key]).slice(0, 255);
  return result;
}
async function requireFolder(client: ZimbraReader, id: string, parent = false): Promise<void> {
  const value = list((await client.folder(id)).folder)[0];
  if (!isSoapObject(value) || String(value.id) !== id || value.zid || value.owner || (String(value.view ?? '') !== 'message' && !(parent && id === '1'))) throw new SafeError('FOLDER_UNSUPPORTED');
}
async function trash(client: ZimbraReader, ids: string[], draftOnly = false): Promise<SoapObject> {
  // Preflight every target before mutation; explicit Trash moves cannot purge.
  for (const id of ids) {
    const m = await get(client, id);
    if (draftOnly) requireDraft(m);
    if (String(m.l) === '3') throw new SafeError('ALREADY_IN_TRASH');
  }
  return client.moveMessages(ids, '3');
}

// Defense in depth: isolate memory is not durable or an exactly-once guarantee.
// Zimbra suid also has a bounded process-local cache. Never automatically retry.
const sends = new Map<string, number>();
async function reserveSend(env: Env, uid: string): Promise<void> {
  const bytes = new TextEncoder().encode(`${env.ZIMBRA_URL}\n${env.ZIMBRA_USER}\n${uid}`);
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  for (const [k, until] of sends) if (until <= now) sends.delete(k);
  if (sends.has(key)) throw new SafeError('SEND_UID_REUSED');
  if (sends.size >= 1000) throw new SafeError('SEND_GUARD_FULL');
  sends.set(key, now + 24 * 60 * 60 * 1000);
}

export const WRITE_TOOLS = Object.freeze([
  defineTool('zimbra_send_message', 'Send one authorized plain-text email, or reply to a specific original message. Explicit To/Cc/Bcc arrays and full content are required; never infer reply recipients. reply_to_message_id adds original threading. No automatic retry. A send can have irreversible consequences.',
    z.strictObject({ ...compose, send_uid: sendUid, reply_to_message_id: id.optional() })
      .refine(validRecipients, 'At most 100 unique recipients are allowed across To/Cc/Bcc.')
      .refine(a => a.to.length + a.cc.length + a.bcc.length > 0, 'At least one explicit recipient is required.'), annotation(true),
    async (a, env, fetchImpl) => {
      const client = new ZimbraReader(env, fetchImpl);
      const m = composeMessage(a);
      if (a.reply_to_message_id) {
        const original = await get(client, a.reply_to_message_id);
        const mid = plain(original.mid);
        if (typeof mid !== 'string' || !mid || mid.length > 998 || /[\r\n\u0000-\u001f]/.test(mid)) throw new SafeError('REPLY_THREAD_UNAVAILABLE');
        m.origid = a.reply_to_message_id; m.rt = 'r'; m.irt = { _content: mid };
      }
      await reserveSend(env, a.send_uid);
      const data = await client.sendMessage(m, a.send_uid);
      const sent = confirmation(data.m);
      // Only a truly empty raw node confirms an account that saves no sent copy.
      return Object.keys(sent).length === 0 ? { completed: true, send_uid: a.send_uid } : changed(data, 'm', { send_uid: a.send_uid });
    }),
  defineTool('zimbra_save_draft', 'Create a plain-text draft, or replace a draft using draft_id and expected_modseq from get_message. Replacement requires a current complete plain-text draft, rejects concurrent changes atomically, and refuses HTML, attachments, reply/forward, scheduled, receipt-request, non-default priority or alternate-identity metadata. Never sends.',
    z.strictObject({ ...compose, draft_id: id.optional(), expected_modseq: z.string().min(1).max(20).regex(/^[0-9]+$/).refine(value => Number(value) <= 2147483647, 'Modification sequence is too large.').optional() })
      .refine(validRecipients, 'At most 100 unique recipients are allowed across To/Cc/Bcc.')
      .refine(a => (a.draft_id !== undefined) === (a.expected_modseq !== undefined), 'draft_id and expected_modseq must be supplied together.'), annotation(true),
    async (a, env, fetchImpl) => {
      const client = new ZimbraReader(env, fetchImpl);
      const m = composeMessage(a);
      if (a.draft_id) {
        const original = await get(client, a.draft_id); requireDraft(original); requirePlainDraft(original, env);
        if (String(original.ms) !== a.expected_modseq) throw new SafeError('DRAFT_CHANGED');
        m.id = a.draft_id;
      }
      const result = changed(await client.saveDraft(m, a.expected_modseq), 'm', {});
      if (a.draft_id && result.id !== a.draft_id) throw new SafeError('WRITE_OUTCOME_UNKNOWN');
      return result;
    }),
  defineTool('zimbra_delete_draft', 'Move one verified draft to Trash. Recoverable subject to server retention; no permanent purge. Requires the exact authorized draft ID.',
    z.strictObject({ draft_id: id }), annotation(true),
    async (a, env, fetchImpl) => changed(await trash(new ZimbraReader(env, fetchImpl), [a.draft_id], true), 'action', { ids: [a.draft_id], destination_folder_id: '3', recoverable: true })),
  defineTool('zimbra_move_messages', 'Move authorized messages to an explicit existing mail folder ID. For archive, first identify or create the intended Archive folder and pass its ID; there is no assumed archive destination. No folder deletion.',
    z.strictObject({ ids, folder_id: id.refine(value => !['1', '3', '4', '5'].includes(value), 'Use a normal mail folder; use trash_messages for Trash.') }), annotation(true, true),
    async (a, env, fetchImpl) => {
      const client = new ZimbraReader(env, fetchImpl);
      await requireFolder(client, a.folder_id);
      return changed(await client.moveMessages(a.ids, a.folder_id), 'action', { ids: a.ids, destination_folder_id: a.folder_id });
    }),
  defineTool('zimbra_trash_messages', 'Move authorized messages to Trash, subject to server retention. Refuses messages already in Trash so repeating the operation cannot become permanent deletion. No purge.',
    z.strictObject({ ids }), annotation(true, true),
    async (a, env, fetchImpl) => changed(await trash(new ZimbraReader(env, fetchImpl), a.ids), 'action', { ids: a.ids, destination_folder_id: '3', recoverable: true })),
  defineTool('zimbra_set_read', 'Set the read/unread state of explicitly authorized messages.', z.strictObject({ ids, read: z.boolean() }), annotation(true, true),
    async (a, env, fetchImpl) => changed(await new ZimbraReader(env, fetchImpl).setRead(a.ids, a.read), 'action', { ids: a.ids, read: a.read })),
  defineTool('zimbra_set_flag', 'Set or clear the starred/flagged state of explicitly authorized messages.', z.strictObject({ ids, flagged: z.boolean() }), annotation(true, true),
    async (a, env, fetchImpl) => changed(await new ZimbraReader(env, fetchImpl).setFlag(a.ids, a.flagged), 'action', { ids: a.ids, flagged: a.flagged })),
  defineTool('zimbra_set_tag', 'Add or remove one existing tag on explicitly authorized messages; preserves all other tags.', z.strictObject({ ids, tag_id: id, add: z.boolean() }), annotation(true, true),
    async (a, env, fetchImpl) => changed(await new ZimbraReader(env, fetchImpl).setTag(a.ids, a.tag_id, a.add), 'action', { ids: a.ids, tag_id: a.tag_id, added: a.add })),
  defineTool('zimbra_create_folder', 'Create one mail folder under an explicit existing local parent folder. Does not change folder permissions or sharing.', z.strictObject({ name: short('New single folder name, without path separators'), parent_id: id }), annotation(false),
    async (a, env, fetchImpl) => {
      const client = new ZimbraReader(env, fetchImpl);
      await requireFolder(client, a.parent_id, true);
      return changed(await client.createFolder(a.name, a.parent_id), 'folder', {});
    }),
  defineTool('zimbra_create_tag', 'Create a mailbox tag for classification. Does not apply it to any messages.', z.strictObject({ name: short('New tag name'), color: z.int().min(0).max(127).optional() }), annotation(false),
    async (a, env, fetchImpl) => changed(await new ZimbraReader(env, fetchImpl).createTag(a.name, a.color), 'tag', {})),
]);

export async function callWriteTool(name: string, args: unknown, env: Env = {}, fetchImpl: FetchImpl = fetch): Promise<CallToolResult> {
  if (env.ZIMBRA_WRITE_ENABLED !== 'true') throw new SafeError('WRITE_DISABLED');
  const tool = WRITE_TOOLS.find(tool => tool.name === name);
  if (!tool) throw new SafeError('UNKNOWN_TOOL');
  return tool.execute(args, env, fetchImpl);
}
