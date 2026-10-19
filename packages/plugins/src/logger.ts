import { ready as readyHooks, thread as threadHooks, stream as streamHooks, turn as turnHooks, model as modelHooks, tool as toolHooks, diagnostic as diagnosticHooks, session as sessionHooks } from "@tessar/core";
import { type EventContext, type Plugin, type PluginContext } from "@tessar/core";
export interface LogEntry extends EventContext {
  level: "info" | "warn" | "error";
  type: string;
  timestamp: string;
  payload: unknown;
}
export interface LoggerOptions {
  write?: (entry: LogEntry) => void | Promise<void>;
}
const events = [
  readyHooks,
  threadHooks.started,
  threadHooks.shutdown,
  threadHooks.forked,
  threadHooks.renamed,
  threadHooks.deleted,
  streamHooks.started,
  streamHooks.end,
  streamHooks.error,
  streamHooks.suspended,
  streamHooks.resumed,
  streamHooks.cancel,
  turnHooks.start,
  turnHooks.end,
  modelHooks.start,
  modelHooks.end,
  modelHooks.error,
  toolHooks.start,
  toolHooks.end,
  toolHooks.error,
  diagnosticHooks,
  sessionHooks.created,
  sessionHooks.modelChanged,
  sessionHooks.threadCreated,
  sessionHooks.threadSwitched,
  sessionHooks.threadRenamed,
  sessionHooks.threadForked,
  sessionHooks.threadDeleted,
  sessionHooks.inputQueued,
  sessionHooks.inputDiscarded,
  sessionHooks.closed,
] as const;

/** Structured lifecycle/error logs. Destinations and formatting belong to the host. */
export class LoggerPlugin implements Plugin {
  readonly id = "logger";
  private readonly write: NonNullable<LoggerOptions["write"]>;

  constructor(options: LoggerOptions = {}) {
    this.write =
      options.write ??
      ((entry) => {
        console.error(JSON.stringify(entry));
      });
  }

  setup(tessar: PluginContext): void {
    for (const name of events)
      tessar.hook(name, (event) =>
        this.write(
          Object.freeze({
            ...event,
            timestamp: event.timestamp ?? new Date().toISOString(),
            level:
              "error" in event.payload && event.payload.error
                ? "error"
                : event.type === streamHooks.suspended
                  ? "warn"
                  : "info",
          }),
        ),
      );
  }
}

export default new LoggerPlugin();
