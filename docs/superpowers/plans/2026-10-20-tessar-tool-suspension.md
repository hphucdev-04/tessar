# Tool Suspension and Standalone Resume Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task using native execution. Steps use checkboxes for tracking.

**Goal:** Let developer-defined tools request suspension, then resume the same execution with a tool result, including when the developer uses only `Agent.stream()`.

**Architecture:** Extend the existing interrupt/checkpoint/resume path with a tool-result continuation. Keep suspended standalone runtimes alive until continuation or cancellation. Agent, Thread and Session share execution machinery; Session remains optional.

**Tech Stack:** TypeScript, Zod, existing core runtime and storage backends. No new dependencies.

**Spec:** The design contract below records the agreed behavior and proposes the concrete API for review. No runtime changes are made by this plan.

## Global constraints

- Agent still requires a default executable model for standalone calls.
- Standalone execution requires no public initialize or per-call dispose.
- Tools remain application/plugin-defined; do not ship an `ask_user` tool.
- Suspension is an execution capability, independent of Session.
- Approval hooks retain their existing decision semantics.
- Reuse `stream.suspended`, `stream.resumed`, InterruptRecord and existing checkpoints.
- Preserve existing dirty work, including documentation/package changes outside this feature.
- Keep implementation helpers out of an increasingly large Agent class.

## Design contract

### Proposed tool API

```ts
const askUser = createTool({
  name: "ask_user",
  description: "Ask the user for information needed to continue.",
  schema: z.object({ question: z.string() }),
  resumeSchema: z.string().min(1),
  execute: ({ question }, context) => context.suspend({ question }),
});
```

- `context.suspend(payload: JsonValue): ToolSuspension` returns a dedicated control value. It does not block a JavaScript stack or throw a normal tool error.
- The developer returns this value from `execute`; code after the return does not run on resume. This is suspension at a tool-result boundary, not arbitrary continuation inside a function.
- Optional `resumeSchema` validates the response using the registered tool's Zod parser. If omitted, accept JSON values using core JSON validation. It is not sent to the model as tool input schema.
- On resume, normalize the parsed answer into a correlated ToolMessage through the existing result path. Plugins can transform that result with `tool.result`.
- Ordinary JSON resembling a suspension request remains ordinary tool output; only the dedicated control value changes execution flow.

### Proposed standalone resume API

```ts
const execution = agent.stream("Ask which database I want to use.");
// Consume the stream. Save event.threadId and event.payload.interrupt.id
// when event.is(stream.suspended), then allow this attachment to finish.

const continued = agent.resume({
  threadId,
  interruptId,
  value: "PostgreSQL",
});
for await (const event of continued) {
  // Same execution/stream ID, new delivery handle.
}
```

`Agent.resume(options: AgentResumeOptions): Stream`, where options contain
`threadId: string`, `interruptId: string`, `value: JsonValue`, optional `signal: AbortSignal`
and optional `scope: Scope`. It validates the referenced thread and resumes its
pending request. It does not create a new turn from a user message.

The retained runtime must preserve the effective model, endpoint, credentials,
protocol and per-call options used by the suspended execution. Do not silently
rebind to Agent's default model. The next attachment waits until the previous
attachment has released its lease; callers can request resume from a suspended
event handler without racing cleanup.

`session.resume(...)` and `thread.stream({ resume: ... })` keep their existing
signatures and delegate to the same core continuation behavior. `generate()` can
still return a suspended outcome; its IDs can be passed to `agent.resume()`.

### State and lifecycle

- Add optional `InterruptRecord.kind: "decision" | "tool-result"`; absence means legacy `decision`.
- Tool-result requests use existing actionRef correlation, payload and responseSchema. Validate against the registered tool, not a plugin interruption resolver. Keep resolvedDecision null for tool-result requests.
- Add `suspended` to ToolExecutionRecord.status. Store its request and status atomically; no partial ToolMessage is sent to the model.
- Include the resume contract in tool registration compatibility fingerprints; current fingerprints cover only input schemas.
- No new tables or physical-schema version changes are planned: current backends store extensible JSON records with string statuses. Verify round trips on all backends.
- Standalone memory state survives between attachments in the same Agent instance. Durable restart requires an explicitly configured durable backend through the existing Controller path, but not a Session.
- Terminal completion/error, waiting cancellation and Agent.shutdown release retained standalone resources. Invalid responses leave the request available for a corrected answer.
- A finished suspended handle can abort its still-waiting execution; once resumed, that old handle must not cancel the new attachment.

### Parallel tools

Finish and commit already-dispatched siblings before publishing a suspension
event. Stop launching queued siblings after suspension is observed. Preserve
completed results, pending calls and all returned suspension requests. Expose
one active request at a time in original model tool-call order, matching the
current scalar pendingInterruptId. Later requests remain stored and become active
after earlier responses; they do not require re-executing their tools.

Unresolved external outcomes still require recovery. A tool deliberately waiting
for a response must not be classified as an unknown external outcome. Recovery
after a crash between saving a waiting request and activating its checkpoint
must rediscover that request without calling execute again.

## Implementation status

Implemented with optional `ToolDefinition.resume(response, originalInput, context)`
as agreed after this plan was written. Without that callback, the validated
response becomes the tool result. With it, the callback returns the result or
another suspension. The original `execute` is never replayed.

Local verification: build, typecheck, package boundaries, 286 unit tests, 30
integration tests and 29 server-storage tests pass. PostgreSQL was exercised;
MongoDB and Linux execution await CI. Six `0.1.1` tarballs passed release,
license and keyword validation. No publication or Git mutation was performed.

## Review focus

1. Two ask_user calls in one model response: both are answered without re-execution or losing a request.
2. Fast resume from a suspended callback: lease release and admission are ordered, with no duplicate consumption.
3. Malformed answer or changed resume schema: reject without consuming the request or sending a tool result.
4. Completed sibling plus waiting/crashed sibling: retain completed results and distinguish suspension from uncertain side effects.
5. Per-call model override plus suspension: continue with the same effective connection and options.

## Implementation tasks

### Task 1: Represent tool-result suspension

**Files:** `packages/core/src/tools/tool.ts`, new `packages/core/src/tools/suspension.ts`, `packages/core/src/index.ts`, `packages/core/src/trace/records.ts`, `packages/core/src/state/schema.ts`, `packages/core/src/engine/runtime.ts`.

**Interface:** Add ToolSuspension, optional ToolDefinition.resumeSchema and ToolExecutionContext.suspend. Widen internal tool-result types without normalizing suspension into ToolMessage. Expose the necessary public types through core and core/tool.

- [ ] Write tests in `packages/core/test/tools/tool.test.ts` and extend `packages/core/test/public-types.test.ts`: ordinary results stay ToolMessage, suspension stays a control value, JSON lookalikes stay data, resume schemas infer correctly, non-JSON payloads are rejected.
- [ ] Run `pnpm exec vitest run packages/core/test/tools/tool.test.ts packages/core/test/public-types.test.ts --configLoader native --pool threads --maxWorkers 4` and observe missing-contract failures.
- [ ] Implement the API and additive record fields, including resume-contract registration fingerprints.
- [ ] Re-run those tests and `pnpm typecheck`; both must pass.

### Task 2: Suspend and resume through the common execution path

**Files:** new `packages/core/src/engine/suspension.ts`, existing `engine/hooks.ts`, `engine/tool-executor.ts`, `engine/resume.ts`, `engine/recovery.ts`, `engine/execution.ts`, and `loop.ts` if needed for continuation routing.

**Interfaces:** Persist waiting tool requests separately from activating suspension; resume a tool-result request with the registered response parser and existing result publication. Existing decision interruption contracts remain unchanged.

- [ ] Add `packages/core/test/engine/tool-suspension.test.ts`: validate answers, preserve stream/tool-call IDs, consume once, send answers as tool messages, and assert the execute counter remains one.
- [ ] Add parallel cases: completed sibling, not-yet-dispatched sibling, two waiting tools, invalid second response and uncertain sibling outcome. Verify original tool-result ordering.
- [ ] Add a crash-boundary case after request persistence but before activation. Recovery must reveal the saved question without re-running execute.
- [ ] Run the new tests to observe failures, then implement through shared helpers. Do not catch control values as tool failures.
- [ ] Run the new tests together with `packages/core/test/engine/interrupt.test.ts` and existing parallel/recovery tests. Legacy approval must still resume past handlers exactly once.

### Task 3: Resume without Controller or Session

**Files:** `packages/core/src/agent.ts`, `engine/call.ts`, `engine/delivery.ts`, new `engine/continuation.ts`.

**Interface:** AgentResumeOptions and Agent.resume(options): Stream; continuation helpers retain standalone runtime/model bindings and own their cleanup. Keep Agent itself a small delegating entry point.

- [ ] Add `packages/core/test/agent-resume.test.ts` using only new Agent, a scripted adapter and a directly configured tool. Do not construct Controller or Session in the test.
- [ ] Assert suspended stream closes, a later resume uses the same stream ID and a new handle, invalid responses remain correctable, duplicate responses fail, and a second suspension works.
- [ ] Assert resume triggered while the prior attachment is finishing waits for cleanup/lease release. Preserve model/endpoint/options from a per-call override.
- [ ] Assert generate returns the pending request, normal calls still clean up automatically, abort cancels waiting work, stale handles cannot abort a continuation, and shutdown releases all retained resources.
- [ ] Observe failing tests, implement retention/admission/cancellation helpers, then re-run them and existing standalone Agent tests.

### Task 4: Durable continuation, compatibility and developer guide

**Files:** `tests/integration/tool-suspension.test.ts`, `tests/fixtures/tool-suspension-worker.ts`, shared `packages/core/src/testing/storage-conformance.ts`, backend test files in `packages/{sqlite,postgresql,mongodb}/test/`, and `examples/guide/tools.md`, `sessions.md`, `stream.md`.

**Interface:** Demonstrate real public tool suspension and unchanged Session/Thread entry points. Verify additive record persistence without a database migration.

- [ ] Add a two-process SQLite test: first process suspends, second restores through Controller + Thread without Session, validates and resumes, and never replays a completed tool.
- [ ] Verify legacy interrupts with no kind still follow decision resume. All backend conformance cases round-trip tool-result requests and suspended statuses.
- [ ] Document a complete ask_user example with Agent.stream + Agent.resume, a separate Session example and explicit in-memory versus restart behavior. Label no proposed API as already shipped before its implementation passes.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm test --maxWorkers 4`, `pnpm test:integration --maxWorkers 4` and `pnpm check:boundaries`.
- [ ] Run `pnpm test:storage --maxWorkers 4` with configured real databases; report unavailable databases as unverified, not passed. Run Windows and Linux CI.
- [ ] Review the final diff and preserve unrelated dirty changes. Do not publish or move tags as part of this feature.

## Scope assessment

This is a medium core change, not a full runtime rewrite or a one-method patch.
Most work is in tool-result handling, shared resume and standalone lifecycle;
tests are a substantial part of the feature. Provider HTTP adapters, CLI/UI,
built-in ask_user behavior, process orchestration and storage DDL are outside the
implementation scope.
