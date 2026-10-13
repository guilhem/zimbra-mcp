// SOAP read mappings adapted from jeremie-lesage/zimbra-mcp (MIT).
// See NOTICE.md for upstream provenance and deliberate differences.
import { z } from 'zod/v4';

// Environment bindings are untrusted until checked at their use sites.
export interface Env {
  MCP_AUTH_MODE?: unknown;
  MCP_ALLOWED_USER_ID?: unknown;
  MCP_ALLOWED_USER_EMAIL?: unknown;
  ZIMBRA_URL?: unknown;
  ZIMBRA_USER?: unknown;
  ZIMBRA_PASSWORD?: unknown;
  ZIMBRA_WRITE_ENABLED?: unknown;
}
export type FetchImpl = typeof globalThis.fetch;
export type SoapObject = Record<string, unknown>;
export const SoapObjectSchema = z.record(z.string(), z.unknown());
export const SoapEnvelopeSchema = z.looseObject({ Body: SoapObjectSchema });
export type SoapEnvelope = z.infer<typeof SoapEnvelopeSchema>;

const MAIL = 'urn:zimbraMail';
const ACCOUNT = 'urn:zimbraAccount';
const ALLOWED_READS = new Set(['SearchRequest', 'GetMsgRequest', 'GetFolderRequest', 'GetTagRequest']);
const ALLOWED_WRITES = new Set(['SendMsgRequest', 'SaveDraftRequest', 'MsgActionRequest', 'CreateFolderRequest', 'CreateTagRequest']);
const RETRY_AUTH = new Set(['service.AUTH_EXPIRED', 'service.AUTH_REQUIRED']);
const SAFE_CODES = new Set([...RETRY_AUTH, 'account.AUTH_FAILED', 'account.TWO_FACTOR_AUTH_REQUIRED',
  'service.PERM_DENIED', 'mail.NO_SUCH_MSG', 'mail.NO_SUCH_FOLDER', 'service.INVALID_REQUEST',
  'mail.MODIFY_CONFLICT', 'mail.ALREADY_EXISTS', 'mail.NO_SUCH_TAG', 'service.PARSE_ERROR', 'service.UNAVAILABLE', 'service.FAILURE']);
const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  CONFIGURATION_REQUIRED: 'Mailbox connection requires securely configured credentials and a public HTTPS Zimbra hostname using the standard SOAP endpoint.',
  RESPONSE_TOO_LARGE: 'Response exceeds the configured size limit.',
  UPSTREAM_REDIRECT_BLOCKED: 'Zimbra redirected the request; forwarding credentials is disabled.',
  INVALID_UPSTREAM_RESPONSE: 'Zimbra returned an unexpected JSON SOAP response.',
  UPSTREAM_HTTP_ERROR: 'Zimbra returned an HTTP error.',
  UPSTREAM_TIMEOUT: 'Zimbra did not respond within 15 seconds.',
  UPSTREAM_UNAVAILABLE: 'Could not reach the configured Zimbra server.',
  INVALID_AUTH_RESPONSE: 'Zimbra did not return a usable authentication token.',
  OPERATION_NOT_ALLOWED: 'Only explicitly allowed operations are supported.',
  WRITE_DISABLED: 'Mailbox writes are disabled by the owner.',
  WRITE_OUTCOME_UNKNOWN: 'The write may have completed. Do not repeat it automatically. Check the mailbox before deciding what to do next.',
  INVALID_ARGUMENTS: 'Tool arguments are invalid.',
  UNKNOWN_TOOL: 'Unknown or disabled tool.',
  MESSAGE_NOT_FOUND: 'The requested message was not returned.',
  NOT_A_DRAFT: 'The selected message is not a draft.',
  DRAFT_CONTENT_UNSUPPORTED: 'This draft has content, delivery settings or reply/identity metadata that this plain-text tool cannot preserve. Edit it in Zimbra.',
  DRAFT_CHANGED: 'The draft modification sequence changed. Read it again before replacing it.',
  FOLDER_UNSUPPORTED: 'Choose an existing local mail folder. Shared, virtual and non-mail folders are not supported.',
  ALREADY_IN_TRASH: 'A selected message is already in Trash. No messages were changed.',
  SEND_UID_REUSED: 'This send identifier was already attempted. Check Sent; do not automatically retry or use a new identifier to bypass this check.',
  SEND_GUARD_FULL: 'Send protection is at capacity. Try later only after checking the mailbox.',
  REPLY_THREAD_UNAVAILABLE: 'Original Message-ID is unavailable; reply safely in Zimbra.',
  INTERNAL_ERROR: 'The request could not be completed.',
};

export class SafeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(SAFE_MESSAGES[code] ?? (code === 'account.AUTH_FAILED' ? 'Mailbox authentication failed.' : 'Zimbra rejected the request.'));
    this.name = 'SafeError';
    this.code = code;
  }
}

// Only locally selected messages may cross the MCP boundary, even for SafeError.
export function safeErrorText(error: unknown): string {
  if (error instanceof SafeError && (Object.hasOwn(SAFE_MESSAGES, error.code) || SAFE_CODES.has(error.code) || error.code === 'ZIMBRA_REQUEST_FAILED')) {
    return `${error.code}: ${new SafeError(error.code).message}`;
  }
  return `INTERNAL_ERROR: ${SAFE_MESSAGES.INTERNAL_ERROR}`;
}

export function isSoapObject(value: unknown): value is SoapObject {
  return SoapObjectSchema.safeParse(value).success;
}
export function soapObject(value: unknown): SoapObject {
  if (!isSoapObject(value)) throw new SafeError('INVALID_UPSTREAM_RESPONSE');
  // Keep raw keys: schema cloning drops __proto__, which must not become empty-send success.
  return value;
}
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
export function plain(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return isSoapObject(value) ? value._content : undefined;
}

export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SafeError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

export function soapEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new SafeError('CONFIGURATION_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError('CONFIGURATION_REQUIRED'); }
  // The destination is administrator configuration, never a tool argument.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !['', '/', '/service/soap', '/service/soap/'].includes(url.pathname) ||
      url.hostname === 'localhost' || !url.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.startsWith('[')) throw new SafeError('CONFIGURATION_REQUIRED');
  url.pathname = '/service/soap';
  return url.href;
}

const FaultSchema = z.looseObject({ Detail: z.looseObject({ Error: z.unknown().optional() }).optional() });
function faultCode(fault: unknown): string {
  const parsed = FaultSchema.safeParse(fault);
  const detail = SoapObjectSchema.safeParse(list(parsed.success ? parsed.data.Detail?.Error : undefined)[0]);
  const code = detail.success ? plain(detail.data.Code) : undefined;
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'ZIMBRA_REQUEST_FAILED';
}

type Change = { token: string; type: 'mod' };
export class ZimbraReader {
  #endpoint: string;
  #user: string;
  #password: string;
  #fetch: FetchImpl;
  #token: string | undefined;
  #writeEnabled: boolean;
  constructor(env: Env = {}, fetchImpl: FetchImpl = fetch) {
    if (typeof env.ZIMBRA_URL !== 'string' || !env.ZIMBRA_URL || typeof env.ZIMBRA_USER !== 'string' || !env.ZIMBRA_USER ||
        typeof env.ZIMBRA_PASSWORD !== 'string' || !env.ZIMBRA_PASSWORD) throw new SafeError('CONFIGURATION_REQUIRED');
    this.#writeEnabled = env.ZIMBRA_WRITE_ENABLED === 'true';
    this.#endpoint = soapEndpoint(env.ZIMBRA_URL);
    this.#user = env.ZIMBRA_USER;
    this.#password = env.ZIMBRA_PASSWORD;
    // Native Worker fetch requires the global receiver, not this reader.
    this.#fetch = fetchImpl.bind(globalThis);
  }

  async #send(name: string, namespace: string, params: SoapObject, token?: string, change?: Change): Promise<SoapObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const context: SoapObject = { _jsns: 'urn:zimbra', userAgent: { name: 'zimbra-mcp-private', version: '0.2.0' } };
      if (change) context.change = change;
      if (token) context.authToken = { _content: token };
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      // Routing cookies go only to the pinned HTTPS endpoint, never into a URL.
      if (token) headers.Cookie = `ZM_AUTH_TOKEN=${token}`;
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST', headers, redirect: 'manual', signal: controller.signal,
        body: JSON.stringify({ Header: { context }, Body: { [name]: { _jsns: namespace, ...params } } }),
      });
      // Workers lacks redirect:'error'; reject before credentials can be forwarded.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SafeError('UPSTREAM_REDIRECT_BLOCKED');
      }
      const text = await readBounded(response.body, 4 * 1024 * 1024);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new SafeError('INVALID_UPSTREAM_RESPONSE'); }
      const parsed = SoapEnvelopeSchema.safeParse(value);
      if (!parsed.success) throw new SafeError('INVALID_UPSTREAM_RESPONSE');
      if (parsed.data.Body.Fault) throw new SafeError(faultCode(parsed.data.Body.Fault));
      if (!response.ok) throw new SafeError('UPSTREAM_HTTP_ERROR');
      return soapObject(parsed.data.Body[name.replace(/Request$/, 'Response')]);
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
    } finally { clearTimeout(timeout); }
  }

  async #authenticate(): Promise<void> {
    const data = await this.#send('AuthRequest', ACCOUNT, {
      account: { by: 'name', _content: this.#user }, password: { _content: this.#password }, persistAuthTokenCookie: false,
    });
    const token = plain(list(data.authToken)[0]);
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\s;,\u0000-\u001f\u007f]/.test(token)) throw new SafeError('INVALID_AUTH_RESPONSE');
    this.#token = token;
  }

  async #read(name: string, params: SoapObject = {}): Promise<SoapObject> {
    if (!ALLOWED_READS.has(name)) throw new SafeError('OPERATION_NOT_ALLOWED');
    try {
      await this.#authenticate();
      try { return await this.#send(name, MAIL, params, this.#token); }
      catch (error) {
        if (!(error instanceof SafeError) || !RETRY_AUTH.has(error.code)) throw error;
        await this.#authenticate();
        return await this.#send(name, MAIL, params, this.#token);
      }
    } finally { this.#token = undefined; }
  }

  async #write(name: string, params: SoapObject, change?: Change): Promise<SoapObject> {
    if (!this.#writeEnabled) throw new SafeError('WRITE_DISABLED');
    if (!ALLOWED_WRITES.has(name)) throw new SafeError('OPERATION_NOT_ALLOWED');
    try {
      await this.#authenticate();
      // A failed mutation may already have committed. Never retry, including auth failures.
      try { return await this.#send(name, MAIL, params, this.#token, change); }
      catch (error) {
        if (error instanceof SafeError && (RETRY_AUTH.has(error.code) || ['mail.MODIFY_CONFLICT', 'mail.ALREADY_EXISTS', 'mail.NO_SUCH_TAG', 'service.PERM_DENIED', 'service.INVALID_REQUEST', 'mail.NO_SUCH_MSG', 'mail.NO_SUCH_FOLDER'].includes(error.code))) throw error;
        throw new SafeError('WRITE_OUTCOME_UNKNOWN');
      }
    } finally { this.#token = undefined; }
  }

  sendMessage(message: SoapObject, sendUid: string): Promise<SoapObject> { return this.#write('SendMsgRequest', { m: message, suid: sendUid }); }
  saveDraft(message: SoapObject, expectedModseq?: string): Promise<SoapObject> { return this.#write('SaveDraftRequest', { m: message, wantModSeq: true }, expectedModseq === undefined ? undefined : { token: expectedModseq, type: 'mod' }); }
  moveMessages(ids: string[], folderId: string): Promise<SoapObject> { return this.#write('MsgActionRequest', { action: { id: ids.join(','), op: 'move', l: folderId } }); }
  setRead(ids: string[], read: boolean): Promise<SoapObject> { return this.#write('MsgActionRequest', { action: { id: ids.join(','), op: read ? 'read' : '!read' } }); }
  setFlag(ids: string[], flagged: boolean): Promise<SoapObject> { return this.#write('MsgActionRequest', { action: { id: ids.join(','), op: flagged ? 'flag' : '!flag' } }); }
  setTag(ids: string[], tagId: string, add: boolean): Promise<SoapObject> { return this.#write('MsgActionRequest', { action: { id: ids.join(','), op: add ? 'tag' : '!tag', t: tagId } }); }
  createFolder(name: string, parentId: string): Promise<SoapObject> { return this.#write('CreateFolderRequest', { folder: { name, l: parentId, view: 'message' } }); }
  createTag(name: string, color?: number): Promise<SoapObject> { return this.#write('CreateTagRequest', { tag: { name, ...(color === undefined ? {} : { color }) } }); }
  search(query: string, limit: number, offset: number): Promise<SoapObject> {
    return this.#read('SearchRequest', { query, types: 'message', limit, offset, sortBy: 'dateDesc', fetch: 'none', read: false, html: false });
  }
  message(id: string): Promise<SoapObject> {
    return this.#read('GetMsgRequest', { m: { id, read: false, html: false, neuter: true, wantModSeq: true, max: 100000, needExp: true } });
  }
  folder(id: string): Promise<SoapObject> { return this.#read('GetFolderRequest', { folder: { id }, tr: false, needGranteeName: false }); }
  folders(path: string): Promise<SoapObject> { return this.#read('GetFolderRequest', { folder: { path }, tr: false, needGranteeName: false }); }
  tags(): Promise<SoapObject> { return this.#read('GetTagRequest'); }
}
