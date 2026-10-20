import type { Controller } from "../controller.js";
import type {
  Agent,
  AgentExecutionOptions,
  AgentInput,
  GenerateOutcome,
  ModelSelection,
} from "../agent.js";
import { HumanMessage } from "../messages/message.js";
import { MessageCodec } from "../messages/codec.js";
import { fail, requireId } from "../errors.js";
import { immutable, type JsonObject } from "../json.js";
import { isModelAdapter } from "../models/stream.js";
import { snapshotModelOptions } from "../models/options.js";
import type { ModelAdapter, ModelRef } from "../models/contract.js";
import { ThreadService } from "../state/threads.js";
import { standaloneRuntime, type ExecutionRuntime } from "./runtime.js";
import type { Stream } from "./delivery.js";

export function modelRef(model: ModelSelection): ModelRef {
  return "ref" in model ? model.ref : model;
}

function chooseModel(
  agent: Agent<any>,
  selection: ModelSelection | string,
): { ref: ModelRef; adapter?: ModelAdapter } {
  if (typeof selection === "string") {
    requireId(selection, "model id");
    if (isModelAdapter(agent.model)) {
      if (selection === agent.model.ref.modelId)
        return { ref: agent.model.ref, adapter: agent.model };
      if (!agent.model.withModel)
        fail(
          "UnsupportedModelSelection",
          "This adapter does not support changing the model ID",
        );
      const adapter = agent.model.withModel(selection);
      return { ref: adapter.ref, adapter };
    }
    return { ref: { ...modelRef(agent.model), modelId: selection } };
  }
  if (isModelAdapter(selection))
    return { ref: selection.ref, adapter: selection };
  const ref = modelRef(selection);
  if (
    isModelAdapter(agent.model) &&
    agent.model.ref.providerId === ref.providerId &&
    agent.model.ref.connectionId === ref.connectionId
  ) {
    if (agent.model.ref.modelId === ref.modelId)
      return { ref, adapter: agent.model };
    if (agent.model.withModel)
      return { ref, adapter: agent.model.withModel(ref.modelId) };
  }
  return { ref };
}

export function callAgent(
  agent: Agent<any>,
  input: AgentInput,
  options: AgentExecutionOptions<any>,
  controller?: Controller,
): Stream {
  const selected = chooseModel(agent, options.model ?? agent.model);
  const runtime = controller ?? standaloneRuntime(agent.id, agent.tools);
  try {
    controller?.requireReady();
    if (!controller && !selected.adapter)
      fail(
        "MissingProvider",
        "Standalone execution requires an executable model instance",
      );
    const ref = immutable(
      selected.adapter
        ? selected.ref
        : controller!.resolveModel(selected.ref).ref,
    );
    requireId(ref.providerId, "provider id");
    requireId(ref.modelId, "model id");
    const overrides = Object.fromEntries(
      Object.entries(options.modelOptions ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    );
    for (const key of [
      "api",
      "model",
      "input",
      "messages",
      "instructions",
      "tools",
      "stream",
      "apiKey",
      "baseURL",
      "defaultHeaders",
      "maxRetries",
      "timeout",
    ])
      if (key in overrides)
        fail("UnsupportedOption", key + " is not a modelOptions field");
    if (
      overrides.background === true ||
      overrides.conversation != null ||
      overrides.previous_response_id != null
    )
      fail(
        "UnsupportedOption",
        "Background and provider-managed conversations are not supported by the Agent loop",
      );
    const modelOptions = snapshotModelOptions({
      ...selected.adapter?.options,
      ...overrides,
    });
    const values =
      typeof input === "string"
        ? [new HumanMessage(input)]
        : Array.isArray(input)
          ? input
          : [input];
    const messages = values.map((value) =>
      MessageCodec.encode(MessageCodec.decode(MessageCodec.encode(value))),
    );
    const threadId = agent.ids.next("thread");
    const prepare = controller
      ? () =>
          controller
            .prepareThread({ scope: options.scope }, threadId)
            .then(() => {})
      : () =>
          new ThreadService(runtime.backend, {
            next: (kind) =>
              kind === "thread" ? threadId : agent.ids.next(kind),
          })
            .create({ scope: options.scope })
            .then(() => {});
    return agent.admit(
      {
        kind: "input",
        threadId,
        input: messages,
        model: ref,
        adapter: selected.adapter,
        modelOptions,
        context: options.context,
        limits: options.limits,
        signal: options.signal,
      },
      { kind: "iterator" },
      prepare,
      runtime,
      controller
        ? undefined
        : async () => {
            await runtime.hooks.dispose();
            await runtime.backend.close();
          },
    );
  } catch (error) {
    // No async resources are started before admission. Discard the empty host/backend.
    if (!controller) {
      void runtime.hooks.dispose();
      void runtime.backend.close();
    }
    throw error;
  }
}

export async function readOutcome(
  runtime: ExecutionRuntime,
  stream: Stream,
): Promise<GenerateOutcome> {
  if (!stream.id) fail("AdmissionFailed", "Execution was not admitted");
  const record = await runtime.queries.getStream(stream.threadId, stream.id);
  if (!record) fail("StorageUnavailable", "Committed execution missing");
  const cp = await runtime.queries.snapshot(stream.threadId),
    pending = cp.execution?.pendingInterruptId;
  return {
    threadId: stream.threadId,
    streamId: record.id,
    status: record.status,
    output: cp.state.messages.filter((message) =>
      record.outputMessageIds.includes(message.id),
    ),
    usage: record.directUsage,
    interrupt: pending
      ? await runtime.queries.getInterrupt(stream.threadId, pending)
      : null,
    error: record.error,
  };
}
