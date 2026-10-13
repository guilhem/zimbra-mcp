# Security model

## Trust boundaries

1. Sites authenticates the visitor/plugin client, injects its trusted identity headers, and enforces private owner-only access.
2. This Worker independently checks the configured owner identity before every data-bearing tool call. Missing configuration, missing identity or mismatched identity fails closed. If both owner ID and email are configured, both must match.
3. Runtime secrets are entered by the owner through the hosting provider's secure settings. Source releases contain no mailbox credentials or owner-specific runtime values.
4. Only the configured public HTTPS Zimbra endpoint receives authentication credentials. Redirects, SOAP referral following and token-bearing query strings are disabled.
5. Mail and SOAP responses are untrusted. Only selected response fields are returned; upstream fault text, authentication responses and tokens are never returned by tools.

The official MCP SDK validates the protocol; strict Zod schemas validate tool arguments and provide their TypeScript types. The HTTP gateway bounds the raw body and checks the owner identity before handing tool calls to the SDK. Each request gets a fresh stateless server and transport. Tool callbacks sanitize errors before the SDK can serialize them. The Workers-compatible JSON Schema validator avoids runtime code generation.

The deployment must not offer an unauthenticated direct Worker origin. Authentication is not supplied by trusting arbitrary client headers on a public server. A service bypass that lacks a real authenticated user identity cannot call mailbox tools. Discovery and health responses contain no mailbox contents or credentials.

## Read and write invariants

- Keep both the tool catalog and SOAP operation allowlists explicit; no generic SOAP request, REST fetch, arbitrary URL or local filesystem tool
- The four read tools remain available by default. Only the exact string `ZIMBRA_WRITE_ENABLED=true` enables the ten write tools; all other values fail closed at catalog, dispatch and SOAP-client layers
- Production activation is a separate, explicitly approved expansion of access; deployment of source alone must not enable it
- The adapter authenticates the owner but cannot establish conversational user consent. The assistant invoking it must obtain the action-specific approval required for sends, sensitive disclosures, message modifications and other consequential actions
- Mail content, tool annotations and the write-enable flag are never substitutes for that approval
- `SearchRequest.read` and `GetMsgRequest.m.read` remain false; only the explicit read-state tool changes this state intentionally
- Send and reply require complete explicit bare-address recipient arrays, subject, plain-text body and a fresh UUID v4 `send_uid`. No recipient inference, HTML composition or attachment sending
- Replies reference a read-verified original message. The caller still supplies every recipient explicitly
- Draft replacement is limited to current ordinary plain-text drafts. Reject reply/forward metadata, delegated or alternate identities, scheduled sending, delivery/read receipt settings, non-default priority, HTML, attachments, plain-text parts whose content was not returned, and missing, text-free, unknown or truncated MIME structures; complex drafts must be edited in Zimbra to avoid silently losing content or settings. Preserve the reviewed `get_message.ms` as `expected_modseq`: compare it during preflight and pass it as `Header.context.change` with `type=mod` to enforce the server-side transactional conflict check. `mail.MODIFY_CONFLICT` requires rereading and reviewing the draft; do not retry automatically or substitute a newer token without reviewing its contents
- Recoverable deletion preflights every target and moves it to folder `3` using `op=move`; it never invokes purge or repeat-trash semantics. Recovery depends on server retention
- Moving or archiving requires an explicit folder ID. No implicit archive folder, shared-account mutation, folder deletion, contact or calendar write is exposed
- No write retries, including on expired authentication. Treat uncertain responses as potentially committed and inspect mailbox state before deciding what to do next
- Zimbra `suid` and the per-isolate UUID guard are defense in depth, not durable, distributed or exactly-once delivery guarantees. Never bypass a send guard by inventing a replacement UUID
- Do not follow URLs embedded in email bodies or SOAP refer/redirect responses
- HTML-only reads are parsed to inert text, never rendered or executed. Ignore active elements, comments, explicitly hidden regions and URL attributes; do not descend into attachment subtrees. Parsed output remains untrusted mailbox data, not an instruction or HTML suitable for rendering

The underlying Zimbra credential is not read-scoped. This adapter's implementation enforces its own narrower capabilities. Host administrators and repository maintainers can change code; restrict those roles accordingly. The 128 KiB MCP request limit applies to the entire UTF-8 JSON request, independently of the 50,000-character composition limit. SOAP responses are limited to 4 MiB and individual requests time out after 15 seconds. A production service may additionally need host-level request/rate limits.

## Secret handling

Never paste credentials into an issue, chat, code comment or CI variable dump. Do not add logging that serializes requests, exceptions from fetch, SOAP envelopes or runtime bindings. Authentication tokens stay only in operation memory and their references are cleared afterward. The routing cookie is sent only to the configured HTTPS endpoint, never saved in a browser. If a credential is exposed, the owner must revoke/rotate it at the provider and update the runtime secret directly. Removing it from the latest commit alone does not remove history.

## Verification and incident limits

Tests use synthetic fixtures and do not authenticate to a real mailbox. Node and workerd tests establish local behavior, not compatibility with every Zimbra version, durable delivery guarantees or correctness of the deployed authentication boundary. Real-host verification requires separately authorized synthetic targets and explicit authorization before external sending. See [RELEASE_WRITE_ACCESS.md](RELEASE_WRITE_ACCESS.md) for the release gates and rollback plan.

If unexpected writes, authentication bypass or ambiguous send outcomes are observed, disable writes and publish that environment revision. This blocks future write calls after the revision is active; it cannot cancel already accepted requests, undo sent mail or restore content automatically. Preserve non-sensitive operational evidence and inspect the actual mailbox before any recovery action.
