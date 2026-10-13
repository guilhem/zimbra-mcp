import assert from 'node:assert/strict';

export const MCP_ACCEPT = 'application/json, text/event-stream';

export function recordCall(url: Parameters<typeof fetch>[0], options?: RequestInit) {
  assert.ok(options, 'SOAP requests must include fetch options');
  assert.ok(typeof options.body === 'string', 'SOAP requests must carry a JSON string');
  return { url, options, body: JSON.parse(options.body) };
}

export type RecordedCall = ReturnType<typeof recordCall>;
