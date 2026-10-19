# Tools and parallel execution

Agreed in conversation; implementation authorized by the user on 2026-10-16.
Zod conversion follows its [native JSON Schema documentation](https://zod.dev/json-schema).

## Public contract

- `createTool({ name, description, schema, execute, recovery? })` uses Zod 4 for argument inference and validation. There is no tool input/output schema pair. Native `z.toJSONSchema(schema, { io: "input" })` supplies provider descriptions.
- `execute(input, context)` can return text, JSON, or `ToolMessage`, synchronously or asynchronously. The Tool normalizes this to a ToolMessage. Undefined and non-JSON values fail explicitly.
- `new ToolMessage(content, options?)` follows the other message constructors. Metadata and provider state remain available. Its toolCallId is optional during construction; encoding persisted/provider context requires correlation. Runtime binds correlation without replacing the message's identity or metadata.
- Agent accepts `tools: { concurrency?: number, [alias]: Tool | number | undefined }`. The concurrency key is reserved. Other keys collect tools; actual tool identity remains `tool.name`. Omitted concurrency means no scheduling limit. Explicit concurrency must be a positive integer.
- Agent tools and plugin tools share selection, hooks, dispatch, collision checks, snapshots, and recovery. Duplicate tool names fail. No retry or enabled config fields; developers/plugins own policy.

## Execution and durability

- Prepare and authorize pending calls sequentially before dispatch. Suspending one call dispatches none of the newly prepared group. Persist allowed/denied policy decisions so resume does not repeat approvals or transforms.
- Execute admitted calls concurrently, with a worker limit only when configured. Validate/transform each dispatched input once, before execution.
- Persist each completion independently, and append correlated results in original call order before the next model invocation. A pending call with a saved result is never executed again.
- Keep individual running/interrupted tool records. Recovery reconciles every outstanding dispatched call; unknown outcomes require recovery, and safe-to-retry is explicit. Cancellation does not silently replay external side effects.
- Concurrent tracked effects and auxiliary model calls retain the originating toolExecutionId. Avoid shared mutable current-tool identity.
- OpenAI Responses serializes canonical JSON data tool results as JSON text; message metadata stays local. Unsupported part kinds fail explicitly.

## Scope

Update source, affected tests, docs, and existing examples. Preserve the existing uncommitted release preparation. No publishing, version bumps, new skill/subagent subsystem, or plugin policy fields.
