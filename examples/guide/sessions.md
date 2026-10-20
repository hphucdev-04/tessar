# Controller and Session

[All guides](README.md) · Next: [Storage](storage.md)

A Controller adds plugin and service lifecycle to an Agent. A Session tracks the
selected thread and model, queues follow-ups and exposes events through
`subscribe()`. A thread owns conversation history; a Session can select among
several threads.

## A two-message conversation

Save as `conversation.ts` after the [setup](README.md).

```ts
import { Agent, Controller, HumanMessage, message, stream } from "@tessar/core";
import { OpenAIProvider } from "@tessar/openai";

const agent = new Agent({
  id: "assistant",
  model: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
});
const controller = new Controller({ id: "my-app", agent });

try {
  await controller.initialize();
  const session = await controller.createSession({ scope: { userId: "demo-user" } });
  const thread = await session.thread.create({ title: "First conversation" });

  async function ask(text: string): Promise<void> {
    let unsubscribe = () => {};
    const completed = new Promise<void>((resolve, reject) => {
      unsubscribe = session.subscribe(event => {
        if (event.type === message.delta && event.payload.partKind === "text") {
          process.stdout.write(event.payload.delta);
        }
        if (event.type === stream.end) resolve();
        if (event.type === stream.error) reject(Error(event.payload.error.message));
        if (event.type === stream.suspended) reject(Error("Execution needs a resume response"));
      });
    });
    try {
      await session.followUp(new HumanMessage(text));
      await completed;
      console.log();
    } finally {
      unsubscribe();
    }
  }

  await ask("My name is Alex. Remember it for this conversation.");
  await ask("What is my name?");

  console.log("Session:", session.id, "Thread:", thread.id);
  console.log((await session.thread.getHistory({ limit: 20 })).items);
} finally {
  await controller.dispose();
}
```

```sh
node --env-file=.env conversation.ts
```

The subscription is installed before submitting input. `followUp()` acknowledges
queued input; it does not wait for the model's final answer. The small `ask()`
helper waits for the completion event so this standalone example can close
cleanly. An interactive application normally subscribes once and leaves its
Controller alive across requests.

You can call `followUp()` while work is running: accepted input waits in the
Session queue. Input that has not yet been admitted is held in memory. Failed or
canceled work can discard queued input; observe Session events in your UI.

## Thread operations

These are operations on a Session instance, after initialization:

| API | Behavior |
| --- | --- |
| `session.thread.create({ title })` | Create and select a new thread |
| `session.thread.getId()` | Read the selected thread ID, or `null` |
| `session.thread.get(id)` | Get a thread within the Session's scope |
| `session.thread.list({ limit, cursor })` | Page through threads in scope |
| `session.thread.switch(id)` | Select an existing thread |
| `session.thread.rename(title)` | Rename the selected thread |
| `session.thread.getHistory({ limit, cursor })` | Page through message history |
| `session.thread.fork()` | Create a fork; explicitly switch to its returned ID to select it |
| `session.thread.delete()` | Soft-delete the selected thread |
| `session.abort(reason)` | Abort active work |
| `session.model.ref` | Read the selected provider/model identity |
| `session.setModel(model)` | Select a model for future follow-ups |

Thread selection changes are rejected while work is running. `fork()` also
accepts an exact `atCheckpointId` or `atMessageId`; a fork point must not contain
unresolved tool calls. History pages return `items` and `nextCursor`.

Agent and Controller IDs are application-defined and must be unique among live
instances of each kind in one loaded core runtime. Session IDs are generated.
Scope filters state; your backend still owns user authentication and authorization.

The default backend is in memory. See [Storage](storage.md) to restore history
and Session selection after an application restart.

## Resume a tool question

Tools can [return `context.suspend(payload)`](tools.md#suspend-a-tool-to-ask-the-user)
to wait for user input or approval. Keep your subscription alive while waiting;
`session.resume()` acknowledges the response and subsequent events arrive through
that same subscription. For example, this application helper connects an existing
Session to your UI:

```ts
import { stream as executionEvents, type Session, type JsonValue } from "@tessar/core";

function connectQuestions(
  session: Session,
  render: (interruptId: string, payload: JsonValue) => void,
) {
  const unsubscribe = session.subscribe(executionEvents.suspended, event => {
    render(event.payload.interrupt.id, event.payload.interrupt.payload);
  });
  return {
    submit: (interruptId: string, value: JsonValue) => session.resume({ interruptId, value }),
    unsubscribe,
  };
}
```

Your form handler calls `submit()` with the selected value. Handle a rejected
response in your UI; schema validation errors leave the question pending for a
corrected answer. Queued follow-ups wait until the suspended execution completes.
One Session has one foreground execution; use separate Sessions for concurrent
tabs or jobs. Answering a tool question does not re-run that tool's `execute()`.
