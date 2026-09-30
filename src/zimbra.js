// Read-only SOAP mappings adapted from jeremie-lesage/zimbra-mcp (MIT).
// See NOTICE.md for upstream provenance and deliberate differences.

const MAIL = 'urn:zimbraMail';
const ACCOUNT = 'urn:zimbraAccount';
const ALLOWED_READS = new Set(['SearchRequest', 'GetMsgRequest', 'GetFolderRequest', 'GetTagRequest']);
const RETRY_AUTH = new Set(['service.AUTH_EXPIRED', 'service.AUTH_REQUIRED']);
const SAFE_CODES = new Set([...RETRY_AUTH, 'account.AUTH_FAILED', 'account.TWO_FACTOR_AUTH_REQUIRED',
  'service.PERM_DENIED', 'mail.NO_SUCH_MSG', 'mail.NO_SUCH_FOLDER', 'service.INVALID_REQUEST',
  'service.PARSE_ERROR', 'service.UNAVAILABLE', 'service.FAILURE']);

export class SafeError extends Error {
  constructor(code, message) { super(message); this.name = 'SafeError'; this.code = code; }
}

export async function readBounded(body, limit) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SafeError('RESPONSE_TOO_LARGE', 'Response exceeds the configured size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

export function soapEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new SafeError('CONFIGURATION_REQUIRED', 'Configure a valid HTTPS Zimbra URL.'); }
  // The destination is administrator configuration, never a tool argument.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !['', '/', '/service/soap', '/service/soap/'].includes(url.pathname) ||
      url.hostname === 'localhost' || !url.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.startsWith('[')) {
    throw new SafeError('CONFIGURATION_REQUIRED', 'Zimbra requires a public HTTPS hostname and the standard SOAP endpoint.');
  }
  url.pathname = '/service/soap';
  return url.href;
}

function faultCode(fault) {
  const detail = fault?.Detail?.Error;
  const candidate = (Array.isArray(detail) ? detail[0] : detail)?.Code;
  const value = typeof candidate === 'object' ? candidate?._content : candidate;
  return SAFE_CODES.has(value) ? value : 'ZIMBRA_REQUEST_FAILED';
}

export class ZimbraReader {
  #endpoint; #user; #password; #fetch; #token;
  constructor(env, fetchImpl = fetch) {
    if (!env.ZIMBRA_URL || !env.ZIMBRA_USER || !env.ZIMBRA_PASSWORD) {
      throw new SafeError('CONFIGURATION_REQUIRED', 'Mailbox connection has not been securely configured.');
    }
    this.#endpoint = soapEndpoint(env.ZIMBRA_URL);
    this.#user = env.ZIMBRA_USER;
    this.#password = env.ZIMBRA_PASSWORD;
    this.#fetch = fetchImpl;
  }

  async #send(name, namespace, params, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const context = { _jsns: 'urn:zimbra', userAgent: { name: 'zimbra-mcp-private', version: '0.1.0' } };
      if (token) context.authToken = { _content: token };
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      // Some Zimbra clusters need this cookie for authenticated mailbox routing.
      // Only send it to the pinned HTTPS endpoint. Never put a token in the URL.
      if (token) headers.Cookie = `ZM_AUTH_TOKEN=${token}`;
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST', headers, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ Header: { context }, Body: { [name]: { _jsns: namespace, ...params } } }),
      });
      const text = await readBounded(response.body, 4 * 1024 * 1024);
      let result;
      try { result = JSON.parse(text); } catch { throw new SafeError('INVALID_UPSTREAM_RESPONSE', 'Zimbra did not return a JSON SOAP response.'); }
      if (result?.Body?.Fault) {
        const code = faultCode(result.Body.Fault);
        throw new SafeError(code, code === 'account.AUTH_FAILED' ? 'Mailbox authentication failed.' : 'Zimbra rejected the read request.');
      }
      if (!response.ok) throw new SafeError('UPSTREAM_HTTP_ERROR', 'Zimbra returned an HTTP error.');
      const data = result?.Body?.[name.replace(/Request$/, 'Response')];
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new SafeError('INVALID_UPSTREAM_RESPONSE', 'Zimbra returned an unexpected SOAP response.');
      }
      return data;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        controller.signal.aborted ? 'Zimbra did not respond within 15 seconds.' : 'Could not reach the configured Zimbra server.');
    } finally { clearTimeout(timeout); }
  }

  async #authenticate() {
    const data = await this.#send('AuthRequest', ACCOUNT, {
      account: { by: 'name', _content: this.#user }, password: { _content: this.#password },
      persistAuthTokenCookie: false,
    });
    const token = typeof data.authToken === 'string' ? data.authToken : data.authToken?.[0]?._content ?? data.authToken?._content;
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\s;,\r\n]/.test(token)) {
      throw new SafeError('INVALID_AUTH_RESPONSE', 'Zimbra did not return a usable authentication token.');
    }
    this.#token = token;
  }

  async #read(name, params = {}) {
    if (!ALLOWED_READS.has(name)) throw new SafeError('OPERATION_NOT_ALLOWED', 'Only explicitly allowed reads are supported.');
    try {
      await this.#authenticate();
      try { return await this.#send(name, MAIL, params, this.#token); }
      catch (error) {
        if (!RETRY_AUTH.has(error.code)) throw error;
        await this.#authenticate();
        return await this.#send(name, MAIL, params, this.#token);
      }
    } finally { this.#token = undefined; }
  }

  search(query, limit, offset) {
    return this.#read('SearchRequest', { query, types: 'message',
      limit, offset, sortBy: 'dateDesc', fetch: 'none', read: false, html: false });
  }
  message(id) {
    return this.#read('GetMsgRequest', { m: { id, read: false, html: false, neuter: true, max: 100000, needExp: true } });
  }
  folders(path) { return this.#read('GetFolderRequest', { folder: { path }, tr: false, needGranteeName: false }); }
  tags() { return this.#read('GetTagRequest'); }
}
