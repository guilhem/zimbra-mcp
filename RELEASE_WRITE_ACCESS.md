# Version 0.2.0: opt-in write-access release

## Release scope and status

This source release adds ten opt-in write tools while preserving the existing four read tools, inert HTML-to-text reading and private owner authentication. Source publication, production deployment, production write activation and real-mailbox verification are separate milestones. This document is a checklist, not evidence that any deployment or live test has occurred. LICENSE and NOTICE.md remain unchanged.

Default runtime configuration is `ZIMBRA_WRITE_ENABLED=false`; omission has the same effect. Only the exact string `true` activates writes. Do not modify the configured mailbox, owner identity, private visibility or authentication boundary as part of activation. No public access or direct unauthenticated Worker origin is acceptable.

## Gate 1: source and local verification

From a clean Node.js 22-or-newer environment:

```sh
npm ci --ignore-scripts
npm run verify
```

Record the exact commit and test results. Review the generated artifact rather than deploying a different revision. These checks use synthetic SOAP responses, including tests in workerd; they do not authenticate to a provider or prove delivery on the real host.

Review and test the following before activation:

- Four tools with writes absent/false/invalid; fourteen with exact `true`. Disabled write calls must make no mutating SOAP request
- Owner allowlist rejection for missing identity, another identity and service-only requests; both configured identity fields must match
- Explicit send/reply recipients, full plain-text content, UUID v4 validation, duplicate-send defense and no automatic retry after timeout, malformed response or authentication failure
- Draft creation and guarded replacement, rejecting stale/concurrently modified drafts, non-drafts, reply/forward/delegated/alternate identity metadata, scheduled sending, delivery receipt settings, HTML, attachments and missing/text-free/unknown/truncated MIME. Complex drafts must be edited in Zimbra
- All-target preflight before recoverable deletion, rejecting already-trashed messages; deletion uses only move to folder `3`, never purge
- Explicit folder IDs for moves/archive, preservation of other tags, bounded batch operations, read/flag changes, folder/tag creation
- Unread preservation for read tools, inert HTML reads, controlled error text, request-size bounds, endpoint pinning and credential redaction

## Gate 2: deploy read-only and verify the host

1. Obtain approval for the intended deployment and record the source revision. Keep the Site private and its existing owner-only authorization intact.
2. Deploy with writes disabled and apply the new runtime revision. Enter any required secret only through the host's secure settings; never add credentials to source, tests, tickets or release notes.
3. Confirm `/healthz` reports `read_only: true`, MCP initialization reports version `0.2.0`, and fresh tool discovery returns the four read tools. Refresh or reconnect clients if discovery is cached.
4. Perform one authorized low-impact read. With a synthetic unread message, verify search and retrieval preserve its unread state.
5. Verify the actual hosting authentication boundary rejects unauthorized users and service-only requests. A successful mocked test is insufficient evidence of this host-level property.
6. Confirm disabled write calls are rejected. Do not infer write activation or mailbox compatibility merely from a healthy endpoint.

## Gate 3: separate write-activation approval

Before changing the flag, obtain explicit owner approval for expanding this connector's persistent mailbox access to the documented write operations. Explain that sends can be irreversible, recoverable Trash is subject to provider retention, and individual consequential operations still require their own applicable authorization.

After approval, set only `ZIMBRA_WRITE_ENABLED=true` through runtime settings and publish the environment revision. Confirm `read_only: false` and fourteen freshly discovered tools. Keep all identity, private-access, credential and endpoint settings unchanged.

## Gate 4: authorized real-host smoke tests

Use owner-approved synthetic messages, drafts, folders and tags. Record only non-sensitive outcomes and versions; do not copy real identities, message bodies, credentials or private project IDs into this release document.

- Create and read a plain-text draft; update it using the reviewed `zimbra_get_message.ms` as `expected_modseq`. Deliberately stale metadata must be rejected. Check that a concurrent modification cannot be overwritten
- Change and restore synthetic read, flag and tag states; verify unrelated tags remain intact
- Create an approved test folder and move a synthetic message into it and back using verified folder IDs
- Move an approved test message/draft into Trash, verify its folder and reject a repeat Trash call. Restore only with separate authorization when required; do not purge or delete test folders using this release
- Test send/reply only after approval of the exact controlled recipient, content and purpose. Use a fresh UUID per authorized send, inspect Sent and confirm receipt at the controlled destination. Never send to a real correspondent merely to test the connector
- An ambiguous result stops that mutation's test sequence: inspect actual state, report uncertainty and obtain any needed new authorization before another attempt. Never automatically retry, change UUIDs to bypass a refusal or claim exactly-once behavior

If any safety or provider-compatibility check fails, return to read-only mode. Existing automated tests cannot substitute for these live checks.

## Rollback to read-only configuration

1. Set `ZIMBRA_WRITE_ENABLED=false` or remove it, then publish/apply the new environment revision. Preserve private visibility and the configured owner identity.
2. Confirm `/healthz` reports `read_only: true`; refresh clients and verify discovery lists exactly the four read tools.
3. Verify a write tool is rejected and one authorized read still works. A cached client may display old tools, but the active server must reject their execution.
4. If necessary, redeploy the last known-good read-only artifact without changing authentication or exposing the origin. Verify its actual runtime behavior rather than relying only on the source label.
5. Inspect the mailbox for already committed or in-flight effects. Disabling writes cannot retract mail, cancel previously accepted requests or restore prior message state. Recovery actions require appropriate authorization.

There is no database migration or permanent mailbox purge in this release. Rollback disables capabilities; it does not undo mailbox changes. If a credential or authorization boundary was compromised, the owner must separately rotate credentials or repair access controls through the provider's secure flow.
