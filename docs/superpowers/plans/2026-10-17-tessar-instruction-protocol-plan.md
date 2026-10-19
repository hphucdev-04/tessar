# Ordered instructions and OpenAI protocols implementation plan

> Implement inline using superpowers:executing-plans and test-driven-development.
> The user has approved the design in conversation and explicitly asked for its
> implementation; preserve the existing dirty checkout. No commit or publication.

**Goal:** Deterministic instruction ordering, explicit provider protocol selection
and unchanged implicit-cache defaults.

**Spec:** ../specs/2026-10-17-tessar-instruction-protocol-design.md

**Architecture:** Keep the core ModelAdapter contract. Add one Chat adapter/codec
to the existing OpenAI package; OpenAIProvider selects it by constructor API and
retains its SDK client. No generic cache manager or new dependency.

## Tasks

### 1. Ordered instruction contract
- [x] RED: order/default/tie/validation/immutability tests and differently ordered
  plugin registration producing the same final instructions.
- [x] Implement optional finite `order`, sort copy by order/ID, normalize final
  request instructions after hooks through the shared model streaming path.
- [x] GREEN: core instruction/context tests and workspace typecheck.

### 2. Chat protocol path and public API
- [x] RED: SDK HTTP fixtures for protocol selection, option omission and typing,
  text/usage, fragmented tool calls, tool results and reasoning continuity.
- [x] Add Chat codec/adapter and API-specific native option types; keep Responses
  behavior, optional providerId and withModel connection semantics.
- [x] Validate runtime-owned fields, incomplete streams and unsupported inputs;
  preserve SDK errors and prohibit execution-level protocol overrides.
- [x] GREEN: OpenAI tests/typecheck and normal tool-loop/Controller execution.

### 3. Documentation, review and verification
- [x] Document SDK usage, order/default/ties, protocol option differences and
  implicit cache behavior. Mark explicit breakpoint helpers as unimplemented.
- [x] Fresh scoped read-only review and material fixes with regression checks.
- [x] Runnable full suite, full-package attempt, four package/two example builds,
  workspace typecheck, boundaries, public built-API smoke.

## Review focus

- Two plugins registered in opposite orders must produce identical ordered text;
  caller arrays/metadata must not leak or be mutated by serialization.
- Chat and Responses option inference remains distinct for default and per-call
  model changes; API/client settings never become provider HTTP fields.
- Native reasoning/tool items survive later turns, resume and model selection;
  malformed/missing tool identities fail without silently dropping content.
- Unconfigured options, especially cache and streaming-usage settings, stay
  absent. SDK exceptions and midstream failures retain their identity/source.
- `withModel` retains API, credentials/client and connection identity; unrelated
  model instances and protocols cannot reuse opaque context.

## Execution ledger

- Baseline: 175 tests in 43 runnable files passed during the hook change.
- Ruling: use the current dirty dev checkout and this plan as the ledger rather
  than commit/worktree automation; unrelated work must remain intact and .git is
  read-only in this sandbox. Cost if wrong: changes need manual separation later.
- Ruling: omitted order compares as zero; ordinal ID resolves equal priorities.
  This implements the agreed stable tie rule. Existing unspecified-order arrays
  may change order; users specify distinct orders when sequence is significant.
- Ruling: ordinary SDK-shaped Chat behavior is the scope, not a complete catalog
  of provider-specific compatibility flags. Preserve known reasoning fields in
  assistant continuity; unsupported multimodal variants fail explicitly.
- Pre-flight: instruction ordering feeds both protocol serializers through the
  shared ModelAdapter path. Protocol typing must preserve Agent.ModelOptions
  inference; no core provider option union or protocol cache policy is added.
- RED/GREEN: ordering and invalid-order assertions failed before implementation;
  final-request hook ordering failed before shared streaming normalization. All
  now pass, including opposite plugin registration orders and omitted/undefined
  optional orders.
- RED/GREEN: seven initial Chat SDK fixtures failed against the Responses-only
  implementation. Chat now passes protocol/native-option checks, parallel
  fragmented function calls, reasoning/tool history, native SDK errors/retries,
  missing usage and incomplete-stream checks. Additional fixtures cover user
  media/metadata omission and Session suspend/resume with queued follow-up.
- Fresh scoped review used a separate read-only gpt-6-astra agent. Three material
  findings: missing terminal tool calls, duplicate tool IDs, and incomplete
  transport-field guards. Added failing regressions and fixed all three; reviewer
  rechecked the fixes and found no remaining issues in that scope. Duplicate IDs
  already failed downstream in core; the codec now reports the provider failure
  before returning a response instead of misclassifying it as a core message error.
- Transport ownership uses one SDK-typed client-key list for constructor splitting
  and both protocols' runtime guards; no SDK-specific list was added to core.
- Verification: 195 tests in 44 runnable files passed, including the parallel-tool
  integration test. Full package attempt: 194 passed, four plugin-manager tests
  blocked by sandbox `spawn EPERM` in `packages/plugins/test/index.test.ts`.
  Those four are not claimed as passing.
- Verification: workspace test typecheck, package boundaries, all four package
  builds and both existing example builds passed. A Node smoke using built public
  exports exercised Agent.generate with both protocols, ordered serialization and
  absent unconfigured cache/usage settings; it passed.
- Limits: official installed SDK plus deterministic HTTP/SSE fixtures, no live
  provider request or cache-hit measurement. No dependencies, versions, storage
  schemas, publication or explicit cache/history breakpoint APIs were added.
