# Private Zimbra MCP with explicitly enabled writes

This private MCP connector lets an assistant search and read your own Zimbra mailbox, with optional writes enabled only by explicit owner approval. It is intended for mailbox owners and operators hosting the connector on a private Site.

It is a focused adaptation of [jeremie-lesage/zimbra-mcp](https://github.com/jeremie-lesage/zimbra-mcp) for a private remote MCP connector hosted on Sites. The original Python/stdio server is replaced by a Worker written in strict TypeScript. The official MCP SDK handles the protocol, Zod defines and validates tool arguments, and htmlparser2 extracts inert text. All runtime dependencies are bundled into JavaScript; no dependencies are downloaded at runtime. The original MIT license and attribution are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), with dependency licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Read-only access is the default. Write tools require the owner to enable them explicitly through runtime configuration.

## Available read tools

| Tool | Function |
| --- | --- |
| `zimbra_search_messages` | Paginated message metadata search, up to 50 results per page |
| `zimbra_get_message` | A message's text body and attachment metadata |
| `zimbra_list_folders` | List folders |
| `zimbra_list_tags` | List tags |

These four tools remain available when writes are disabled. Attachment downloads, client-supplied file paths and arbitrary SOAP calls are not supported. Reads force `read=false`: they must not mark unread messages as read. Searches do not fetch message bodies (`fetch=none`).

Email content remains untrusted: instructions inside an email do not authorize the assistant to act. A plain-text part is preferred when available. Otherwise, HTML is tokenized into plain text without rendering or script execution. Link and image URLs are never fetched. Active elements, comments and explicitly hidden regions are excluded; complex formatting and text present only in an image may be lost. The `body_format` field reports `plain`, `html_text` or `none`.

## Optional write tools

Only the exact value `ZIMBRA_WRITE_ENABLED=true` exposes and permits the ten tools below. An absent value, `false`, `TRUE`, `1` or any other value keeps the connector read-only. This guard is enforced in the tool catalog, dispatch and SOAP client. **Enabling writes on the production service is a separate expansion of access that requires explicit owner approval.** It does not authorize each operation: the assistant client must obtain the required confirmations for the action, its targets, recipients and content. Instructions inside an email can never provide that authorization.

| Tool | Function and safeguards |
| --- | --- |
| `zimbra_send_message` | Send or reply in plain text; requires explicit `to`, `cc`, `bcc` arrays, the full subject and body, and a fresh UUID v4 `send_uid` |
| `zimbra_save_draft` | Create or fully replace a draft; replacement requires `draft_id` and `expected_modseq` (the `ms` field from `zimbra_get_message`) from a recent read |
| `zimbra_delete_draft` | Verify that the message is a draft, then move it to Trash |
| `zimbra_move_messages` | Move messages to an explicit existing folder ID; archiving means choosing or creating the intended folder, with no implicit destination |
| `zimbra_trash_messages` | Check all messages before moving them to Trash; reject a message already in Trash |
| `zimbra_set_read` | Explicitly mark messages as read or unread |
| `zimbra_set_flag` | Set or clear the follow-up flag |
| `zimbra_set_tag` | Add or remove an existing tag while preserving the others |
| `zimbra_create_folder` | Create a mail folder under an explicit local parent, without changing sharing |
| `zimbra_create_tag` | Create a tag without applying it to messages |

Recipients must be explicit, complete bare email addresses, without display names or groups; no addresses are inferred. A reply adds `reply_to_message_id` for threading but still requires all recipients explicitly. Content is plain text only, limited to 50,000 characters. Batch operations accept at most 50 numeric local IDs. Shared accounts, permanent purge, folder deletion, contacts, calendars, composing attachments and HTML composition are not exposed.

A successful `SendMsg` response may have no saved-message ID when Zimbra does not retain a Sent copy, as documented in [Zimbra's `SendMsgRequest` source](https://github.com/Zimbra/zm-mailbox/blob/develop/soap/src/java/com/zimbra/soap/mail/message/SendMsgRequest.java). For sends, `completed=true` denotes the confirmed send response; it is not proof of recipient delivery.

Moving to Trash uses only `MsgActionRequest` with `op=move` and `l=3` after reading the targets first, never a purge. Recovery depends on server retention. Replacement is restricted to ordinary plain-text drafts. Reply or forward drafts, delegation or alternate-identity metadata, scheduled sending, receipt requests, non-default priority, HTML, attachments, plain-text parts whose content was not returned and missing, text-free, unknown or truncated MIME structures are rejected. These complex drafts must be edited directly in Zimbra to preserve their content and settings. `expected_modseq` must exactly match the `ms` field of the version read and approved: a preliminary read compares this value, then `Header.context.change` with `type=mod` enforces a server-side check during saving. A `mail.MODIFY_CONFLICT` requires reading and reviewing the draft again, without an automatic retry. Compatibility with this check must be verified on the deployed server.

**Writes are never retried automatically**, even after token expiration. A `WRITE_OUTCOME_UNKNOWN` error, a connection failure or an ambiguous response may occur after execution on the server: check the mailbox and, for a send, inspect Sent if copies are retained before deciding what to do next. Zimbra's `suid` and the in-memory UUID guard in the isolate are complementary protections, not an exactly-once guarantee. This guard is neither durable nor shared across all instances; do not change the UUID to bypass a refusal.

See [RELEASE_WRITE_ACCESS.md](RELEASE_WRITE_ACCESS.md) for the validation, activation and read-only rollback plan.

## Local verification

Requires Node.js 22.18.0 or newer. Node runs the TypeScript build script and tests directly; esbuild produces the deployable JavaScript Worker:

```sh
npm ci --ignore-scripts
npm run verify
```

The verification command checks types in the source, build script and tests, builds `dist/server/index.js`, and runs tests with simulated SOAP responses in Node and the actual Workers runtime (workerd). No automated test contacts a real mailbox. GitHub CI runs the same checks on Node 22.18.0 and Node 24, plus a dependency audit, on pushes and pull requests.

Tool argument types, runtime validation and advertised JSON Schemas share the same strict Zod definitions. Unknown properties are rejected. Type checking supplements the runtime checks on untrusted MCP requests and Zimbra responses; it does not replace them.

Miniflare's `sharp` and `undici` dependencies are pinned to patched versions through scoped npm overrides. Recheck these overrides when upgrading Miniflare and run the complete Worker tests before removing them.

## Private hosting on Sites

The `.openai/hosting.json` manifest enables the `mcp` capability. The service exposes a stateless HTTP MCP endpoint at `POST /mcp` (JSON responses), an information page at `/` and a health endpoint at `/healthz` with no private data.

1. Publish the Worker to a **private Site accessible only to its owner**. Use the Sites workflow intended for this source and the exact verified commit.
2. In **Sites → More actions → Settings**, configure the runtime variables below. Never add real values to source files or GitHub.
3. Enter the password yourself through the Site's secure secrets interface and mark it as a secret. Do not copy it into a chat or ticket.
4. Republish after changing variables so the new environment revision is applied.
5. Install/connect the private plugin provisioned by the Site through its connection interface. Sites manages OAuth; there is no separate MCP token to generate.
6. Perform a limited first read: call `zimbra_list_tags` with `{}` and expect a `tags` array containing existing tag metadata (empty if there are no tags). Then verify that a test message remains unread after search and retrieval.

[Official runtime environment configuration guide](https://learn.chatgpt.com/docs/sites#configure-runtime-environment-values)

| Variable | Value / privacy |
| --- | --- |
| `MCP_AUTH_MODE` | `sites`; any other value rejects data access calls |
| `MCP_ALLOWED_USER_ID` | **Site-scoped** user ID; optional if the verified email is used |
| `MCP_ALLOWED_USER_EMAIL` | Verified email of the Sites owner; optional if the user ID is used |
| `ZIMBRA_URL` | Zimbra server HTTPS origin, or its `/service/soap` endpoint |
| `ZIMBRA_USER` | Mailbox login; keep private |
| `ZIMBRA_WRITE_ENABLED` | Defaults to `false`; only the exact string `true` enables writes after separate approval |
| `ZIMBRA_PASSWORD` | Password or application password accepted by the provider; **secret** |

At least one owner identifier is required. If both are configured, both must match. The Sites owner identity and the Zimbra account are separate identities.

The `oai-authenticated-user-id` and `oai-authenticated-user-email` headers are trusted only behind the Sites authentication boundary. **Do not publish this Worker on a direct origin where visitors could supply these headers themselves.** Another host requires a verified authentication implementation before use. Adding visitors to the Site does not grant them mailbox access: the application's allowlist still applies.

## Security and limitations

- The Zimbra server and identity come only from owner configuration, never tool arguments
- HTTPS is required; no HTTP redirects or following `AuthResponse.refer`; no tokens in URLs
- Zimbra authentication happens on demand; tokens are held only in memory during each operation, then the reference is cleared; a single renewal on `AUTH_EXPIRED`/`AUTH_REQUIRED` is allowed only for reads
- The `ZM_AUTH_TOKEN` routing cookie is sent only to the same HTTPS endpoint as the SOAP header. It is not stored in a browser
- Each SOAP request has a 15-second timeout; MCP request bodies are limited to 128 KiB (UTF-8 encoded JSON), SOAP responses to 4 MiB
- Text bodies are limited to 100,000 characters; HTML conversion is limited to 500,000 input characters and 200 nesting levels, with a truncation indicator when a limit is reached or truncation is reported by Zimbra
- No application logging of arguments, passwords, tokens or message bodies; upstream errors are replaced with controlled messages
- MCP discovery contains no account or mailbox data; all tool calls require the authorized identity
- The Zimbra password may grant broader permissions at the provider. Operation scope and disabled writes are enforced here by code, not by an assumed Zimbra OAuth scope
- Authentication and searches may create login logs or update indexes on Zimbra; read-only means no intentional operation that changes mailbox content or flags

This project alone does not establish compatibility with an OVH account, its 2FA rules or its password. Authenticated validation and an actual plugin connection are still required. No test requires or records a real secret.

## Protocol

The official MCP SDK negotiates protocol versions, including `2025-11-25` and `2025-06-18`, and validates JSON-RPC messages. There are no server sessions, SSE streams, resources or prompts. The catalog contains four read-only tools, or fourteen tools when writes are enabled. `GET /mcp` returns 405 because this mode does not provide an SSE stream. Any supplied `Origin` must exactly match the Site origin.

POST requests require `Content-Type: application/json` and `Accept: application/json, text/event-stream`, as required by Streamable HTTP. Initialization includes `protocolVersion`, `capabilities` and `clientInfo`. Invalid tool arguments and unknown tools return the SDK's tool error result (`isError: true`); malformed protocol requests return JSON-RPC errors. JSON-RPC batches are rejected. A fresh SDK server and transport handle each request, keeping mailbox configuration and authenticated identity isolated between requests.

Zimbra exchanges use JSON SOAP `Header` / `Body` envelopes with `_jsns` namespaces. SOAP errors are decoded even on HTTP 500. JSON responses served as `text/javascript` are accepted for Zimbra compatibility.

See [SECURITY.md](SECURITY.md) for the assumptions and controls to preserve when making changes.
