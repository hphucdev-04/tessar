# Tessar identity API

Status: approved scope for the ID changes, 2026-10-21.

## Public creation APIs

| API | Optional identity | Omitted behavior |
| --- | --- | --- |
| `agent.stream(input, options)` | `options.id` | Generate a Stream ID |
| `controller.createSession(options)` | `options.id` | Generate a Session ID |
| `session.thread.create(options)` | `options.id` | Generate a Thread ID |
| `session.thread.fork(options)` | `options.id` for the destination | Generate a destination Thread ID |

These options let applications supply identities already present in Tessar.
They do not create new entities or change the meaning of existing IDs.

Agent and Controller IDs remain required. Messages already accept `options.id`;
OpenAI connections already accept `connectionId`. Runtime checkpoint, commit,
turn, attempt, tool-execution, interruption and attachment IDs remain owned by
runtime. Provider tool-call IDs remain owned by the provider.

## Stream identity

Keep `Stream.id`. A new Stream exposes its supplied or generated ID immediately.
Existing `streamId` fields in results, events, contexts and storage continue to
reference that same execution identity. Resume retains the original execution
ID; a resumed Agent handle obtains it when its interruption is loaded.

`Stream.abort(reason?)` remains the cancellation method; the handle does not expose
an AbortSignal. There is no new execution ID concept or persistence migration.

Future Agent signal routing reuses this ID for an execution target and the existing
Thread ID for a conversation target. See [Signal design](2026-10-21-tessar-signal-design.md)
for the approved routing and open payload/application decisions. Signal delivery is
not implemented by this change. `generate`, Session recovery, followUp and their
receipts retain their existing API shapes.

## Acceptance checks

- Explicit nonempty IDs are preserved; omitted IDs are generated; empty IDs fail.
- Creating or forking an existing Session/Thread ID does not overwrite its state.
- Concurrent inputs on one Agent cannot claim the same Stream ID.
- A new execution cannot replace a stored execution with the same ID.
- Resume and storage restart retain the existing IDs and references.
- A runnable consumer uses built public packages to exercise the changed APIs.
