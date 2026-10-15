import { fail, errorInfo, type ErrorInfo } from "../errors.js";
import type { IdGenerator } from "../json.js";
import {
  EventEnvelope,
  type AnyEvent,
  type EventContext,
} from "../events/definition.js";
import { AgentEvents } from "../events/catalog.js";
export interface Stream extends AsyncIterable<EventEnvelope> {
  readonly id: string | null;
  readonly threadId: string;
  readonly handleId: string;
  readonly signal: AbortSignal;
  abort(reason?: string): void;
}
export type DeliveryTarget =
  | { kind: "iterator" }
  | {
      kind: "observer";
      observe: (event: EventEnvelope) => void;
      admitted?: (receipt: { streamId: string; threadId: string }) => void;
      rejected?: (error: ErrorInfo) => void;
      closed?: () => void;
    };
export interface Attachment {
  stream: Stream;
  controller: AbortController;
  setId(id: string): void;
  emit(definition: AnyEvent, payload: any, context: EventContext): void;
  close(): void;
  admitted(): void;
  rejected(error: ErrorInfo): void;
}
export function createDelivery(
  threadId: string,
  ids: IdGenerator,
  target: DeliveryTarget,
  external?: AbortSignal,
  diagnostics: (error: ErrorInfo, context?: EventContext) => void = () => {},
  limits = { maxEvents: 512, maxBytes: 4 * 1024 * 1024 },
): Attachment {
  const controller = new AbortController(),
    handleId = ids.next("handle");
  let id: string | null = null,
    closed = false,
    consumerEnded = false,
    iterated = false,
    bytes = 0,
    lastCheckpoint: string | null = null;
  const queue: { event: EventEnvelope; bytes: number }[] = [],
    waiting: ((value: IteratorResult<EventEnvelope>) => void)[] = [];
  const report = (error: ErrorInfo, context?: EventContext) => {
    try {
      diagnostics(error, context);
    } catch {
      /* diagnostics cannot control execution */
    }
  };
  const cancel = () => {
    if (!closed) controller.abort(external?.reason);
  };
  if (external?.aborted) cancel();
  else external?.addEventListener("abort", cancel, { once: true });
  const drain = () => {
    if (!queue.length && (closed || consumerEnded))
      for (const resolve of waiting.splice(0))
        resolve({ value: undefined, done: true });
  };
  const stream: Stream = {
    get id() {
      return id;
    },
    threadId,
    handleId,
    signal: controller.signal,
    abort(reason) {
      if (!closed) controller.abort(reason);
    },
    [Symbol.asyncIterator]() {
      if (iterated || target.kind !== "iterator")
        fail(
          "ConsumerAlreadyAttached",
          "Only one iterator consumer is allowed",
        );
      iterated = true;
      return {
        next: () => {
          const item = queue.shift();
          if (item) {
            bytes -= item.bytes;
            return Promise.resolve({ value: item.event, done: false });
          }
          return closed || consumerEnded
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => waiting.push(resolve));
        },
        return: async () => {
          consumerEnded = true;
          queue.length = 0;
          bytes = 0;
          drain();
          return { value: undefined, done: true };
        },
      };
    },
  };
  return {
    stream,
    controller,
    setId(value) {
      id = value;
    },
    emit(definition, payload, context) {
      if (closed) return;
      if (definition === AgentEvents.CheckpointCommitted)
        lastCheckpoint = payload.checkpointId;
      const event = new EventEnvelope(definition, payload, {
        ...context,
        streamId: id,
        threadId,
        handleId,
      });
      if (target.kind === "observer") {
        try {
          const result = target.observe(event) as unknown;
          if (
            result &&
            typeof (result as PromiseLike<unknown>).then === "function"
          )
            void Promise.resolve(result).catch((error) =>
              report(errorInfo(error, { source: "application", eventId: event.type }), event),
            );
        } catch (error) {
          report(errorInfo(error, { source: "application", eventId: event.type }), event);
        }
        return;
      }
      if (consumerEnded) return;
      const resolve = waiting.shift();
      if (resolve) {
        resolve({ value: event, done: false });
        return;
      }
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (
        queue.length + 1 > limits.maxEvents ||
        bytes + size > limits.maxBytes
      ) {
        const error: ErrorInfo = {
          source: "tesseract",
          name: "TesseractError",
          code: "ConsumerTooSlow",
          message: "Stream consumer exceeded its buffer",
          retryable: false,
        };
        queue.length = 0;
        bytes = 0;
        consumerEnded = true;
        queue.push({
          event: new EventEnvelope(
            AgentEvents.StreamError,
            {
              error,
              lastKnownCheckpointId: lastCheckpoint,
              persistedStatus: null,
            },
            { ...context, streamId: id, threadId, handleId },
          ),
          bytes: 0,
        });
        report(error, { ...context, streamId: id, threadId, handleId });
        return;
      }
      queue.push({ event, bytes: size });
      bytes += size;
    },
    close() {
      if (closed) return;
      closed = true;
      external?.removeEventListener("abort", cancel);
      drain();
      if (target.kind === "observer") target.closed?.();
    },
    admitted() {
      if (id && target.kind === "observer")
        target.admitted?.({ streamId: id, threadId });
    },
    rejected(error) {
      if (target.kind === "observer") target.rejected?.(error);
    },
  };
}
