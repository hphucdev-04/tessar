# Technical debt

Tessar targets both CLI agents and agents embedded in applications. This ledger
records missing capabilities and future direction, not implementation designs.
A working terminal example does not establish browser application support.

## TD-002 — Self-hosted server and application/browser client SDK

**Status:** deferred. **Scope:** future application integration work.

### Gap

The current SDK provides an agent runtime and in-process state updates. It does
not provide a complete self-hosted HTTP server and browser client SDK. Application
developers still have to build the connection between backend execution and the
browser themselves. This debt extends beyond rendering snapshots.

### Direction

- Support independent self-hosting with a server that exposes HTTP APIs for
  interacting with the runtime.
- Provide a browser client SDK for interacting with that server and receiving
  accumulated state in real time.
- Cover the complete application flow: conversations, history, thread/model
  selection, incremental text/reasoning, tool activity, user input/approval and
  continued interaction across multiple turns.
- Address reload, reconnection, recovery and multiple users/tabs without
  confusing conversation identity or execution state.
- Preserve integration into a developer's existing backend, alongside the
  independent self-hosting case.
- Let applications choose their UI and presentation. Browser consumers should
  not need to reconstruct conversation state from individual model/tool events.

Completion requires a working server-to-browser application flow, including
continued interaction after reload or disconnection. CLI-only demonstrations
are insufficient evidence for closing this debt.

Class names, constructors, endpoint schemas, transport protocols, package layout
and implementation strategy remain undecided and require a separate design.

## TD-003 — Terminal renderer example

**Status:** open. **Scope:** presentation, independent of TD-002.

The current terminal example can leave repeated snapshot frames in scrollback.
Improve presentation across long output, resizing and repeated runs so old
frames are not mistaken for restored history or additional model executions.

This debt concerns the renderer. A terminal fix does not resolve the missing
self-hosted server or browser application integration.

## Boundaries

Preserve the minimal core and the "anything are plugin" direction. Server,
client and presentation capabilities should be optional additions. Applications
retain control of their backend integration, identity/access policy, deployment
and UI choices.
