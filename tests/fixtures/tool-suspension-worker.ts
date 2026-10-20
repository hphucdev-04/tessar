import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  Agent,
  Controller,
  AssistantMessage,
  HumanMessage,
  MessageCodec,
  createTool,
  checkpoint,
  stream,
} from "@tessar/core";
import { ScriptedProvider } from "@tessar/core/testing";
import { SqliteStoragePlugin } from "@tessar/sqlite";
import { z } from "zod";

const [command, filename] = process.argv.slice(2) as [string, string];
const ask = createTool({
  name: "ask",
  description: "Ask",
  schema: z.object({}),
  resumeSchema: z.string().min(1),
  execute: (_input, context) => {
    appendFileSync(filename + ".calls", "execute\n");
    return context.suspend({ question: "Choose" });
  },
  resume: (value) => {
    appendFileSync(filename + ".calls", "resume\n");
    return value;
  },
});
const starting = command === "start" || command === "crash-wait";
const model = new ScriptedProvider(
  starting
    ? [
        {
          response: {
            message: MessageCodec.encode(
              new AssistantMessage([
                {
                  type: "tool-call",
                  toolCallId: "call",
                  name: "ask",
                  arguments: {},
                },
              ]),
            ),
          },
        },
      ]
    : [{ text: "finished" }],
);
const controller = new Controller({
  id: "host",
  agent: new Agent({ id: "assistant", model, tools: { ask } }),
  plugins: [
    new SqliteStoragePlugin({ filename }),
    {
      id: "crash-boundary",
      setup(tessar) {
        tessar.hook(checkpoint.committed, async (event, context) => {
          const cp = await context.thread?.getCheckpoint(
            event.payload.checkpointId,
          );
          if (command === "crash-answer" && cp?.cause === "Resumed")
            process.exit(0);
          if (
            command === "crash-wait" &&
            cp?.execution &&
            !cp.execution.pendingInterruptId
          ) {
            const requests = await controller.queries.listInterrupts(
              cp.threadId,
            );
            const pending = requests.items.find(
              (r) => r.kind === "tool-result" && r.status === "pending",
            );
            if (pending) {
              writeFileSync(
                filename + ".ids",
                JSON.stringify({
                  threadId: cp.threadId,
                  streamId: cp.execution.streamId,
                  interruptId: pending.id,
                }),
              );
              process.exit(0);
            }
          }
        });
      },
    },
  ],
});
try {
  await controller.initialize();
  const ids = starting
    ? undefined
    : JSON.parse(readFileSync(filename + ".ids", "utf8"));
  const thread = starting
    ? await controller.createThread()
    : (await controller.getThread(ids.threadId))!;
  const execution = starting
    ? thread.stream({ input: new HumanMessage("ask"), model: model.ref })
    : command === "recover"
      ? thread.stream({ recover: { streamId: ids.streamId } })
      : thread.stream({
          resume: { interruptId: ids.interruptId, value: "selected" },
        });
  for await (const event of execution) {
    if (event.is(stream.error)) throw Error(event.payload.error.message);
    if (event.is(stream.suspended)) {
      writeFileSync(
        filename + ".ids",
        JSON.stringify({
          threadId: thread.id,
          streamId: execution.id,
          interruptId: event.payload.interrupt.id,
        }),
      );
      console.log(
        JSON.stringify({
          status: "suspended",
          payload: event.payload.interrupt.payload,
        }),
      );
    }
    if (event.is(stream.end))
      console.log(
        JSON.stringify({
          status: event.payload.status,
          output: event.payload.output,
        }),
      );
  }
} finally {
  await controller.dispose();
}
