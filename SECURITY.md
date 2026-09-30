# Security model

## Trust boundaries

1. Sites authenticates the visitor/plugin client, injects its trusted identity headers, and enforces private owner-only access.
2. This Worker independently checks the configured owner identity before every data-bearing tool call. Missing configuration, missing identity or mismatched identity fails closed.
3. Runtime secrets are entered by the owner through the hosting provider's settings. Source repositories contain no mailbox credentials or owner-specific runtime values.
4. Only the configured public HTTPS Zimbra endpoint receives authentication credentials. Redirects and token-bearing query strings are disabled.
5. Mail and SOAP responses are untrusted. Only selected response fields are returned; upstream fault text, authentication responses and tokens are never returned by tools.

The deployment must not offer an unauthenticated direct Worker origin. Authentication is not supplied by trusting arbitrary client headers on a public server. A service bypass that lacks a real authenticated user identity cannot call mailbox tools.

## Read-only invariants

- Keep both the tool catalog and SOAP operation allowlists explicit
- Do not expose a generic SOAP request, REST fetch, arbitrary URL or local filesystem tool
- `SearchRequest.read` and `GetMsgRequest.m.read` must remain false
- Never register writes based solely on an environment flag such as `ENABLE_SEND=false`
- New operations need their own protocol/authorization review and tests
- Do not follow URLs embedded in email bodies or SOAP refer/redirect responses

The underlying Zimbra credential is not read-scoped. This adapter's intentionally small implementation is the enforcement layer. Host administrators and repository maintainers can change code; restrict those roles accordingly. A production service may additionally need host-level request/rate limits for its own traffic profile.

## Secret handling

Never paste credentials into an issue, chat, code comment or CI variable dump. Do not add logging that serializes requests, exceptions from fetch, SOAP envelopes or runtime bindings. If a credential is exposed, the owner must revoke/rotate it at the provider and update the runtime secret directly. Removing it from the latest commit alone does not remove history.

## Verification limits

Tests use synthetic fixtures and do not authenticate to a real mailbox. They establish local code behavior, not that a specific Zimbra account or deployed authentication boundary is correctly configured. After secure connection, verify one owner-authorized read and preservation of a test message's unread flag. Verify another user and a service-only request remain denied before broadening any access.
