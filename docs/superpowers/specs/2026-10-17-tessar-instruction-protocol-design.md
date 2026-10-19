# Ordered instructions and OpenAI protocols

Date: 2026-10-17. Status: approved for implementation by the user's request to
implement the preceding decisions. Execute in the existing checkout.

## Intent and agreed API

Developers build from `new Agent({ id, model, instructions })` without needing
Controller/Session. Instruction sections must have stable ordering independent
of plugin registration/discovery order. Provider protocol and cache behavior
belong to `@tessar/openai`, not to instruction/state APIs.

- Add optional `InstructionSection.order: number`. Omitted order means zero for
  comparison only; do not inject the field. Sort ascending, then by ordinal ID.
  Validate finite numbers, unique IDs and string content; keep the immutable
  result and do not modify the caller's array.
- Apply ordering when assembling Agent/Thread sections and when sending requests
  after plugin transforms, including auxiliary calls.
- Add `api?: "responses" | "chat-completions"` to OpenAIProvider configuration.
  Responses remains the default. The API is connection metadata, never an HTTP
  request option, and `withModel` preserves it and the SDK connection.
- Infer native request option types from the selected API. Keep the existing
  Responses option alias for compatibility. Chat uses its own native option type.
  `providerId` stays optional for both, defaulting to `openai`.
- Chat serializes instructions as leading system content, supports ordinary
  messages, function tools, text/image input, JSON tool output, streaming and
  usage. Keep native assistant continuity (including compatible-provider
  reasoning text) bound to model/connection/protocol; never silently reuse
  incompatible opaque context or discard unsupported content.
- One Agent execution consumes one Chat choice (`n` omitted or 1). Reject
  unsupported multiple choices and deprecated tool/function overrides explicitly.
- Preserve native SDK error identity/retries/transport configuration. Never retry
  a partially consumed stream at the Agent level.
- Unconfigured provider options remain absent. Do not add cache settings,
  stream_options, temperature, reasoning, token limits or transport defaults.
  Implicit caching remains the provider default. Retain cache read/write usage
  when supplied by the provider.
- No explicit breakpoint helpers, section cache fields, history cache policy,
  provider auto-detection, new storage schema, dependencies or npm publication.

## Verification and limits

Use failing tests first for order/tie determinism, hook contributions, protocol
selection and native options, multi-call tool history/reasoning, missing usage,
cache omission, retries/error identity and type inference. Test with the installed
official SDK and deterministic HTTP/SSE fixtures; no live account/cache-hit claim.
Run the runnable full suite, typecheck, all package/example builds, boundaries
and a built-public-import smoke. Record process-spawn sandbox failures separately.

Reference: https://developers.openai.com/api/docs/guides/migrate-to-responses
Reference: https://developers.openai.com/api/docs/guides/prompt-caching
