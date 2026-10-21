# Tessar signal design

Status: design approved on 2026-10-21; implementation tracked in the linked plan.

Receipt semantics revised on 2026-10-21 after the lifecycle audit: receive input
like followUp, without awaiting admission, persistence or notification callbacks.
This supersedes the original checkpoint-acknowledgement requirement. Public
targets, message options and safe application boundaries are unchanged.

## Approved routing

- The public receiving method belongs to Agent: `agent.sendSignal(...)`.
- Exactly one target is supplied: `streamId` for direct Stream execution, or
  `threadId` for work through a Session. Never supply both.
- `streamId` addresses a specific active execution, using the existing `Stream.id`.
- `threadId` addresses a conversation. If it is executing, deliver to that execution;
  if it is idle, begin processing on that same Thread.
- Session callers can use the existing `session.thread.getId()`; no new
  `session.getStreamId()` or `session.sendSignal()` is needed for this routing.
- `session.subscribe()` observes events; it is not a separate signal target.
- A selected Thread and a currently executing loop are different states. Signal
  reception is not restricted to Threads whose loop is currently running.
- Signal does not cancel the current model/tool step.
- Signal must differ from followUp's queue of subsequent executions.
- A suspended Thread still accepts pending signal input, but signal does not
  resolve the interruption or restart the loop. An explicit resume is required;
  pending signals are applied at the next safe model boundary after resumption.

## Approved application boundary

- Accept incoming signals while the current model/tool step continues.
- Apply them before the next model request, after the complete group of tool
  results requested by the current model response. Do not insert between a
  tool-call and its corresponding tool-result sequence.
- If the model produces a final answer while signals are pending, process accepted
  signals in that same execution before completing it.
- For an idle Thread, begin processing on that same Thread.
- followUp waits for the whole execution to finish before starting another;
  signal applies at the next safe boundary inside the current execution.

## Approved message parameters

- `content` is required and uses the existing message content contract:
  `string | readonly ContentPart[]`.
- The resulting message always has role `user`. There is no public `role`
  parameter and no support for selecting other roles through sendSignal.
- `persist?: boolean` defaults to `true`. Persisted messages are part of canonical
  history/checkpoints; nonpersisted signal input is not saved as a history message.
- `tagName?: string` is optional. Omit it to leave content unwrapped. If supplied,
  wrap content in the named XML element. An XML tag does not change message role.
- `attributes` is optional and adds attributes to that XML element. Scalar
  typing is `Record<string, string | number | boolean>`.
- `metadata?: JsonObject` follows the existing message metadata contract. It is
  application-owned data and is not included in provider input.
- When content consists of multiple parts, preserve those parts inside the XML
  opening/closing text parts rather than converting all content to one string.
- Separate required `type`/`payload` fields are not part of the approved shape.

The approved parameter shape is:

```ts
type SignalTarget =
  | { streamId: string; threadId?: never }
  | { threadId: string; streamId?: never };

type SendSignalOptions = SignalTarget & {
  content: string | readonly ContentPart[];
  persist?: boolean; // default true
  tagName?: string;
  attributes?: Record<string, string | number | boolean>;
  metadata?: JsonObject;
};
```

These types are exported from the SDK. Session routing does not require an
additional sessionId or a new Session sendSignal method.

## Approved runtime behavior

- `sendSignal(options): Promise<void>` acknowledges reception into memory, like
  followUp; it does not await admission, checkpoint writes, notification callbacks
  or completion of model processing. Validation and unavailable targets still
  reject before acceptance. Later startup/write failures use existing execution
  events and diagnostics.
- For persist=true, Tessar writes pending input before applying it to model
  context. Until the write completes, reception is not restart-durable. Admission
  failure or a process crash can discard accepted but uncommitted input, just as
  followUp can lose queued input. Persist=false input is kept only in memory.
- Preparation hooks can submit and await signal receipts without blocking the
  preparation they depend on. The receiving primitive does not trace sender
  contexts or require AsyncLocalStorage. Existing commit-notification ordering
  remains serialized; signal receipts do not await those callbacks.
- Nonpersisted input remains available throughout the receiving execution, including
  later model/tool cycles. It is discarded when that execution ends and is lost
  after process restart. Existing model/tool outputs are still stored normally.
- Pending input whose checkpoint write completed survives restart. Applying it to history and removing it
  from the pending checkpoint must be one committed transition, avoiding replay.
- XML names are validated; attribute values are escaped. Attributes without a tag
  are rejected rather than silently ignored. No separate signal identity is added.
- An idle Session Thread uses that live Session's selected model/options and routes
  events through its existing subscription. If multiple different live Sessions
  select the same idle Thread, reject ambiguous ownership rather than silently
  choosing a Session/model. This does not add public Session sending APIs.
- Missing, deleted or incompatible targets fail explicitly. A signal targeting an
  execution that has already ended fails; a Thread target may start a new execution
  on that same Thread. Cancellation, policy stops and runtime limits retain priority.

## Scope

Implement this receiving primitive with existing messages, checkpoints, ownership
and hooks. Do not add a signal plugin, new storage backend/table, runId, role
selection, scheduler, followUp helpers or new public Session/Controller methods.
Existing persisted checkpoints without pending signal data remain readable.

Implementation plan: `../plans/2026-10-21-tessar-signal-plan.md`.
