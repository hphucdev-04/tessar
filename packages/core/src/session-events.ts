import type { HookSpec } from "./events/definition.js";
import type { ModelRef } from "./models/contract.js";
export interface QueuedInputReceipt {
  id: string;
  threadId: string;
}
export interface ExecutionReceipt {
  streamId: string;
  threadId: string;
}
export const SessionEvents = {
  Created: "session.created",
  ModelChanged: "session.model-changed",
  ThreadCreated: "session.thread-created",
  ThreadSwitched: "session.thread-switched",
  ThreadRenamed: "session.thread-renamed",
  ThreadForked: "session.thread-forked",
  ThreadDeleted: "session.thread-deleted",
  InputQueued: "session.input-queued",
  InputDiscarded: "session.input-discarded",
  BeforeClose: "session.before-close",
  Closed: "session.closed",
} as const;
declare module "./events/definition.js" {
  interface EventMap {
    "session.created": HookSpec<{ model: ModelRef }>;
    "session.model-changed": HookSpec<{ previous: ModelRef; model: ModelRef }>;
    "session.thread-created": HookSpec<{ threadId: string }>;
    "session.thread-switched": HookSpec<{
      previousThreadId: string | null;
      threadId: string;
    }>;
    "session.thread-renamed": HookSpec<{ threadId: string; title: string }>;
    "session.thread-forked": HookSpec<{
      sourceThreadId: string;
      threadId: string;
    }>;
    "session.thread-deleted": HookSpec<{ threadId: string }>;
    "session.input-queued": HookSpec<{ receipt: QueuedInputReceipt }>;
    "session.input-discarded": HookSpec<{
      receipt: QueuedInputReceipt;
      cause: string;
    }>;
    "session.before-close": HookSpec<{}>;
    "session.closed": HookSpec<{}>;
  }
}
