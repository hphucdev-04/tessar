# Tessar Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Implement natively in this session; do not dispatch agents or commit unrelated work.

**Goal:** Add `agent.sendSignal(options): Promise<void>` for delivery to a direct Stream or a Session Thread at the next safe model boundary.

**Architecture:** Reuse execution admission, messages, checkpoint commits and Thread ownership. Keep pending durable input in the receiving execution's checkpoint and transient input in memory. Route idle Threads through their live Session so its selected model and subscription remain authoritative.

**Tech Stack:** TypeScript ESM, Node.js >=24.14.0, pnpm 11.5.3, Vitest, existing storage backends; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-tessar-signal-design.md` (approved 2026-10-21).

**Receipt correction, 2026-10-21:** The user clarified reception must work like
followUp. Receipt means accepted into memory, not persistence completion. Restore
serialized checkpoint notifications, remove hookDepth-based guards, retain
background pending writes and route later failures to events/diagnostics. No
AsyncLocalStorage, Node boundary changes or new public API is needed. The checked
items below use this revised contract, not the superseded durable-receipt design.

## Global Constraints

- Exactly one target is supplied: `streamId` for direct Stream execution, or `threadId` for work through a Session. Never supply both.
- The resulting message always has role `user`. There is no public `role` parameter.
- `persist?: boolean` defaults to `true`.
- Signal does not cancel the current model/tool step.
- Apply before the next model request, after the complete group of tool results.
- Suspended Threads accept input without resolving interruptions or restarting the loop.
- No new public Session/Controller sending method, runId, signal identity, table or backend.
- Preserve unrelated dirty work, public execution IDs and existing followUp behavior. No version bump, commit or publication in this task.

## Review Focus

1. Signal immediately after `agent.stream()` returns must not require waiting for a started event or lose original input; Task 2.
2. Acceptance racing with terminal completion must either be processed in that execution or fail explicitly; Task 3.
3. Parallel tools, suspension and recovery must preserve complete call/result groups; Tasks 3 and 4.
4. Transient input must retain its position across model/tool cycles without leaking into checkpoints, records or restart state; Tasks 2 and 4.
5. Multiple Sessions selecting a Thread, stale handles and Thread switches must not silently choose a model, bypass scope or misroute subscriptions; Task 4.

## Files and responsibilities

- Create `packages/core/src/signal.ts`: public options and message/XML normalization.
- Create `packages/core/src/engine/signals.ts`: internal pending input, safe application and transient context assembly.
- Modify `agent.ts`, `engine/frame.ts`, `engine/execution.ts`, `engine/continuation.ts`: routing and admission/retained execution lifecycle.
- Modify `state/schema.ts`, `engine/checkpoint.ts`, `loop.ts`, `engine/context.ts`: durable pending input, atomic application and completion boundary.
- Modify `controller.ts`, `session.ts`, `thread.ts`: internal live Session registration and idle/suspended Thread delivery.
- Modify `index.ts`: export only `SendSignalOptions` and its target type in addition to Agent's method.
- Tests belong in `packages/core/test/`; built public-consumer and persistence checks in `tests/fixtures/` and `tests/integration/`.
- Update `examples/guide/agent.md`, `examples/guide/sessions.md` and `API-REVIEW.md` with the implemented API.

### Task 1: Public options and user message normalization

**Files:** Create `src/signal.ts` and `test/signal.test.ts` under `packages/core/`; modify `packages/core/src/index.ts`.

**Interfaces:**
- Public `SignalTarget` and `SendSignalOptions` have exactly the fields and types in the spec.
- Internal `createSignalMessage(options: SendSignalOptions): MessageData` returns an immutable, validated user message using existing message constructors/codecs. Keep this helper out of package exports.

- [x] Write failing tests for exactly one nonempty target, required content, default persistence and user role. Assert a runtime `role` supplied from JavaScript cannot produce another role. Test both-target and missing-target rejection.
- [x] Test plain text, multipart content, message/part metadata and caller mutation after submission. Assert wrapping preserves inner parts and metadata without mutating them.
- [x] Test `notification` attributes `{ source: "github", pr: 123, ready: true }`, attribute quote/ampersand escaping, invalid names and attributes without a tag. Use a documented conservative XML name pattern; reject nonfinite numbers and nonscalar attribute values at runtime. Do not escape or stringify the message body itself.
- [x] Run `pnpm exec vitest run packages/core/test/signal.test.ts --configLoader native --pool threads --maxWorkers 4`; confirm missing implementation fails.
- [x] Implement normalization with standard string operations and existing JSON/message validation. Add no XML dependency or public message subtype.
- [x] Rerun the focused test and `pnpm typecheck`; expect success.

### Task 2: Acceptance, checkpoint persistence and transient input

**Files:** Create `packages/core/src/engine/signals.ts` and `packages/core/test/engine/signals.test.ts`; modify `agent.ts`, `engine/frame.ts`, `engine/checkpoint.ts`, `engine/execution.ts`, `engine/continuation.ts`, `state/schema.ts`.

**Interfaces:**
- Public `Agent.sendSignal(options: SendSignalOptions): Promise<void>`; completion acknowledges acceptance only.
- Internal `acceptSignal(context: ExecutionContext, frame: ExecutionFrame, message: MessageData, persist: boolean): Promise<void>`.
- Add optional `ExecutionPosition.pendingSignals?: readonly MessageData[]`; absent means empty for existing checkpoints. It stores only durable, unapplied user messages.
- Internal `applySignals(frame: ExecutionFrame, context: LoopContext): Promise<boolean>` returns whether new input was applied. Internal `signalMessages(frame: ExecutionFrame): readonly MessageData[]` returns canonical messages merged with applied transient messages at their original positions.
- Extend the existing internal commit callback to `commit(frame, cause, change?: () => void): Promise<void>` for serialized synchronous signal mutations; preserve existing callers and checkpoint causes.

- [x] Write gated-provider tests for a signal during model I/O and immediately after `agent.stream("original", { id: "target" })`. Assert acknowledgement without releasing the provider, correct Stream.id, preservation of original input, and no extra initial execution.
- [x] Test rejected admission, unknown/ended Stream, abort and shutdown. Assert no accepted input is silently dropped during admission failure. Include a plugin hook awaiting sendSignal after admission to detect a commit/hook deadlock.
- [x] Test two concurrent durable signals and a concurrent plugin-state commit: both pending messages survive, with no revision rollback or overwritten state. Inject commit failure and assert the execution reports it after reception has been acknowledged.
- [x] Test default durable acceptance by inspecting a checkpoint before the provider is released. Test transient acceptance by inspecting every committed checkpoint/record for absence of its unique content and metadata.
- [x] Run the new tests and confirm failures before implementation.
- [x] Register per-execution routing when admission is reserved, before returning Stream; retain runtime/Thread association until cleanup. Receive early input into memory immediately, and defer its write until original input admission can commit safely. Admission failure is reported through the execution; it does not retroactively reject a receipt.
- [x] Serialize pending writes and postcommit callbacks with existing checkpoint operations. A callback can await a sendSignal receipt because that receipt does not await the write. Write failures stop application of input and use existing error events/diagnostics. Do not roll back in-memory pending data after a successful publication merely because its notification failed.
- [x] For safe application, prepare messages through existing message validation/hooks, then atomically remove exactly the selected pending entries and append durable messages in one checkpoint transition. Preserve arrivals accepted during preparation. Use each existing message ID for correlation; add no signal ID.
- [x] Keep transient pending/applied messages outside serialized state. Anchor applied transient messages to canonical message positions; retain them across attachments to the same suspended execution in this process, discard at terminal cleanup and process restart. Never save a merged context as canonical state.
- [x] Rerun focused tests and typecheck. Expect acknowledgements to resolve during active model I/O, durable data in pending checkpoints and transient data only in memory.

### Task 3: Consume signals at safe loop boundaries

**Files:** Modify `packages/core/src/loop.ts`, `engine/context.ts`, `engine/checkpoint.ts`, `engine/execution.ts`; create `packages/core/test/engine/signal-loop.test.ts`.

**Interfaces:** Consume Task 2's `applySignals` and `signalMessages`. Extend internal `LoopContext` with the existing message-preparation callback needed for application. No new public loop phases, hook catalog or methods.

- [x] Write a scripted model test that requests two parallel tools with independent gates. Accept a signal while one is unfinished; assert the next request contains assistant tool calls, both tool results, then the signal, in that order. Assert neither tool repeats.
- [x] Test a model final answer with pending input: a second model request occurs under the same Stream.id before `stream.end`. Repeat with a signal arriving from `turn.end`/`turn.decision` hooks.
- [x] Test an arriving signal during message preparation and a submission racing normal completion. Assert every successful acceptance before the close boundary is observed and later Stream submissions reject; do not require arbitrary timers for ordering.
- [x] Test that an applied transient message stays before subsequent assistant/tool messages on all later requests, that multiple arrivals preserve acceptance order, and that context.prepare can see/transform them normally.
- [x] Test abort, explicit stop/deny, maxTurns and maxModelAttempts with pending input. Assert signals do not bypass these decisions or force another provider request. Preserve existing input.prepare handled-output behavior while applying the same completion acceptance boundary.
- [x] Run `pnpm exec vitest run packages/core/test/engine/signal-loop.test.ts --configLoader native --pool threads --maxWorkers 4`; verify failures.
- [x] Apply pending messages before context construction for the next model request; merge transient messages before `context.prepare`. Never drain into history during incomplete tool batches or resume replay of an unresolved tool.
- [x] At ordinary completion, synchronously check pending input and close further Stream acceptance as one decision before awaiting finalization hooks. Pending input continues the existing execution; policy/cancellation/limits retain priority. A Thread delivery racing a closing attachment is accepted by its Session and starts on that same Thread after closure, without making the caller await the closing hook.
- [x] Rerun focused tests plus existing tool, resume, recovery and hook suites. Confirm unchanged followUp execution semantics and event.type discrimination.

### Task 4: Session routing, suspended recovery and developer-facing verification

**Files:** Modify `packages/core/src/controller.ts`, `session.ts`, `thread.ts`, `agent.ts`, `engine/frame.ts`, `engine/execution.ts`, `engine/signals.ts`; create `packages/core/test/session-signal.test.ts`, `tests/fixtures/signal-consumer.ts`, `tests/integration/signal-persistence.test.ts`; modify `tests/integration/public-imports.test.ts` and the three reference/guide files listed above.

**Interfaces:**
- Controller keeps a private collection of live Session handles created/restored by it; remove handles after disposal and clear on Controller shutdown.
- Internal Session delivery uses a stripped `/** @internal */` entrypoint receiving the normalized message and persistence flag. Reuse its existing attach/foreground/subscription flow; do not call followUp to simulate signal delivery.
- An internal initial-signal field on input admission carries `{ message: MessageData; persist: boolean }` when starting an idle Thread. It is not an option on public stream/generate/followUp methods. Run existing input hooks and preserve input rejection/handled behavior while routing transient content outside canonical history.

- [x] Write tests for an idle selected Thread and a running Thread: call only `agent.sendSignal({ threadId: session.thread.getId(), content })`; assert subscription events, Session model/options, same Thread, and no followUp receipt or queue item.
- [x] Test two live Sessions selecting one idle Thread, two handles of one Session, stale record revisions, scope mismatch, switching away, disposal and a Thread active in another owner/process. Reject ambiguity or stale/incompatible ownership; do not guess a Session or poll another process. Check registration cleanup without making Controller hold dead Session handles indefinitely.
- [x] Test a suspended tool/approval: accepting a signal leaves interruption and tool counts unchanged; explicit resume finishes the pending tool group and delivers signal before the next model call. Test transient retention across same-process resume and its absence after restart.
- [x] Run focused tests and confirm failures.
- [x] Route active Thread targets to the existing frame; validate live Session selection/scope for Session routing. For idle Threads, require an unambiguous current Session handle and reuse attach with its model/options. Coordinate with its existing control/foreground checks so concurrent signals do not create competing executions.
- [x] For suspended Threads with no active frame, use existing backend ownership and checkpoint commit machinery to append durable pending data without preparing recovery, invoking tools or resolving the interrupt. Release ownership afterward. Reuse in-memory retention for transient data and transfer it when that same execution resumes.
- [x] Add SQLite restart tests: acknowledge a durable signal while suspended, rebuild runtime objects, resume, assert one delivery/no replay and preserved metadata. Read historical and current checkpoints to confirm atomic pending-to-history transition; old checkpoints without the optional field remain readable. Check nonpersistent content is absent after restart and from stored records. Storage implementations already serialize checkpoint execution data; change backend code only if these checks expose an actual incompatibility.
- [x] Add a built public-import fixture showing both routes, XML/metadata, stream event.type and Session subscription, with a small local test provider and no network credentials. Assert there is no public session.sendSignal or runId. Run it directly with `node tests/fixtures/signal-consumer.ts` after building, then wire it into public-imports integration coverage.
- [x] Update guides and API reference from actual exported declarations. Document acknowledgement vs processing, scope/selection requirements, interruption behavior, transient lifetime, and stop/limit precedence. Verify d.ts exposes the intended method/options and strips new routing helpers.
- [x] Run `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries`, `pnpm test --maxWorkers 4` and `pnpm test:integration --maxWorkers 4`. Run `pnpm test:storage --maxWorkers 4` only with configured services; report skips as unverified. If sandbox subprocess restrictions prevent a command, report the exact limitation and direct checks performed instead.
- [x] Review `git diff --check`, public declarations and changed source against the approved spec. Report changed behavior, verified commands and material limits; leave all release/git operations to a separate request.

## Plan self-review

All routing, role/XML/metadata, acknowledgement, persistence, transient lifetime, suspension and safe-boundary requirements map to the four tasks. The five review conditions have explicit tests. Helpers are internal; the only added public behavior is Agent.sendSignal and its option types. Existing hooks, records, storage ports and IDs remain the extension/persistence mechanisms. Execution and live database results are not claimed by this document.
