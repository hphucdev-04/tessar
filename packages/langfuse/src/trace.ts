import { createHash } from "node:crypto";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  RandomIdGenerator,
} from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createObservationAttributes,
  type LangfuseObservationAttributes,
  type LangfuseObservationType,
} from "@langfuse/tracing";
import type { EventContext, MessageData } from "@tessar/core";
import type { LangfuseOptions, ExecutionTrace, TraceLink } from "./types.js";

export function update(
  span: Span,
  type: LangfuseObservationType,
  attributes: LangfuseObservationAttributes,
): void {
  if (span.isRecording())
    span.setAttributes(createObservationAttributes(type, attributes));
}
export const time = (event: EventContext) =>
  event.timestamp ? new Date(event.timestamp) : undefined;
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** Owns the instance-local tracer, span hierarchy and active execution state. */
export function createTracing(options: LangfuseOptions) {
  const random = new RandomIdGenerator();
  let nextTraceId: string | undefined;
  let nextSpanId: string | undefined;
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: options.publicKey,
        secretKey: options.secretKey,
        baseUrl: options.baseUrl,
        shouldExportSpan: ({ otelSpan }) =>
          otelSpan.instrumentationScope.name === "@tessar/langfuse",
      }),
    ],
    idGenerator: {
      generateSpanId: () => nextSpanId ?? random.generateSpanId(),
      generateTraceId: () => nextTraceId ?? random.generateTraceId(),
    },
  });
  const tracer = provider.getTracer("@tessar/langfuse");
  const executions = new Map<string, ExecutionTrace>();
  const links = new Map<string, TraceLink>();
  const linkedSpan = (event: EventContext, spanId: string) =>
    trace.wrapSpanContext({
      traceId: hash(event.threadId!).slice(0, 32),
      spanId,
      traceFlags: 1,
    });

  const start = (
    name: string,
    type: LangfuseObservationType,
    event: EventContext,
    identity: Record<string, unknown>,
    parent?: Span,
    attributes: LangfuseObservationAttributes = {},
    spanId?: string,
  ): Span => {
    nextSpanId = spanId;
    let span: Span;
    try {
      span = tracer.startSpan(
        name,
        {
          startTime: time(event),
          attributes: createObservationAttributes(type, {
            ...attributes,
            metadata: { ...identity, ...attributes.metadata },
          }),
        },
        parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
      );
    } finally {
      nextSpanId = undefined;
    }
    if (event.sessionId) span.setAttribute("session.id", event.sessionId);
    span.setAttribute(
      "langfuse.trace.name",
      options.traceName ??
        (event.sessionId
          ? `${event.agentId ?? "agent"} / ${event.threadId}`
          : (event.agentId ?? "agent")),
    );
    if (options.tags?.length)
      span.setAttribute("langfuse.trace.tags", [...options.tags]);
    return span;
  };

  const begin = (event: EventContext): ExecutionTrace | undefined => {
    if (!event.streamId) return;
    const existing = executions.get(event.streamId);
    if (existing) return existing;
    const identity = Object.fromEntries(
      Object.entries({
        controllerId: event.controllerId,
        agentId: event.agentId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        streamId: event.streamId,
        scope: event.scope,
      }).filter(([, value]) => value !== undefined),
    );
    const link = links.get(event.streamId);
    const rootId = hash(`root:${event.threadId}`).slice(0, 16);
    let root: Span;
    if (link && !link.rootNew) root = linkedSpan(event, rootId);
    else {
      // A Thread always derives the same IDs. Existing observations are not
      // exported again; future operations only refer to their parent context.
      nextTraceId = link
        ? hash(event.threadId!).slice(0, 32)
        : hash(
            JSON.stringify([
              event.controllerId,
              event.agentId,
              event.threadId,
              event.streamId,
            ]),
          ).slice(0, 32);
      try {
        root = start(
          event.agentId ?? "agent",
          "agent",
          event,
          identity,
          undefined,
          { output: [] },
          link ? rootId : undefined,
        );
      } finally {
        nextTraceId = undefined;
      }
    }
    const state: ExecutionTrace = {
      root,
      link,
      identity,
      output: [],
      turns: new Map(),
      models: new Map(),
      tools: new Map(),
      calls: new Map(),
      firstOutputs: new Set(),
    };
    executions.set(event.streamId, state);
    return state;
  };
  const current = (event: EventContext) =>
    event.streamId ? executions.get(event.streamId) : undefined;
  const parentTurn = (
    state: ExecutionTrace,
    event: EventContext,
    id = state.currentTurn,
    index?: number,
  ): Span => {
    if (!id) return state.root;
    let turn = state.turns.get(id);
    if (!turn) {
      let number = index === undefined ? undefined : index + 1;
      if (state.link?.turnId === id) number = state.link.turnCount;
      const spanId = hash(`turn:${event.threadId}:${id}`).slice(0, 16);
      const span =
        state.link?.turnId === id && !state.link.turnNew
          ? linkedSpan(event, spanId)
          : start(
              number === undefined ? "turn" : `turn ${number}`,
              "span",
              event,
              {
                ...state.identity,
                turnId: id,
                ...(index === undefined ? {} : { index }),
                turnNumber: number,
              },
              state.root,
              { output: [] },
              state.link ? spanId : undefined,
            );
      turn = { span, output: [] };
      state.turns.set(id, turn);
    }
    return turn.span;
  };
  const failure = (
    span: Span,
    type: LangfuseObservationType,
    error: { message: string },
  ): void => {
    if (!span.isRecording()) return;
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error.message);
    update(span, type, {
      level: "ERROR",
      statusMessage: error.message,
      metadata: { error },
    });
  };
  const finish = (
    event: EventContext,
    status: string,
    error?: { message: string } | null,
    output?: readonly MessageData[],
  ): void => {
    const state = current(event);
    if (!state) return;
    for (const [spans, type] of [
      [state.models, "generation"],
      [state.tools, "tool"],
      [[...state.turns.values()].map((turn) => turn.span), "span"],
    ] as const) {
      for (const span of spans.values()) {
        if (error) failure(span, type, error);
        update(span, type, {
          level: error ? "ERROR" : "WARNING",
          metadata: {
            status: status === "completed" ? "interrupted" : status,
          },
        });
        span.end(time(event));
      }
    }
    if (error) failure(state.root, "agent", error);
    update(state.root, "agent", {
      output: output ?? state.output,
      metadata: { status },
      ...(status === "suspended" ||
      status === "cancelled" ||
      status === "interrupted"
        ? { level: "WARNING" as const }
        : {}),
    });
    state.root.end(time(event));
    executions.delete(event.streamId!);
    links.delete(event.streamId!);
  };

  return {
    executions,
    links,
    start,
    begin,
    current,
    parentTurn,
    failure,
    finish,
    shutdown: () => provider.shutdown(),
  };
}

export type TraceRuntime = ReturnType<typeof createTracing>;
