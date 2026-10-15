import {
  AgentEvents,
  SessionEvents,
  type EventContext,
  type Plugin,
  type PluginContext,
} from "@tesseract/core";
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
  AgentEvents.Ready,
  AgentEvents.ThreadStarted,
  AgentEvents.ThreadShutdown,
  AgentEvents.StreamStarted,
  AgentEvents.StreamEnd,
  AgentEvents.StreamError,
  AgentEvents.StreamSuspended,
  AgentEvents.StreamResumed,
  AgentEvents.StreamCancel,
  AgentEvents.TurnStart,
  AgentEvents.TurnEnd,
  AgentEvents.ModelStart,
  AgentEvents.ModelEnd,
  AgentEvents.ModelError,
  AgentEvents.ToolStart,
  AgentEvents.ToolEnd,
  AgentEvents.ToolError,
  AgentEvents.Diagnostic,
  SessionEvents.Created,
  SessionEvents.ModelChanged,
  SessionEvents.ThreadCreated,
  SessionEvents.ThreadSwitched,
  SessionEvents.ThreadRenamed,
  SessionEvents.ThreadForked,
  SessionEvents.ThreadDeleted,
  SessionEvents.InputQueued,
  SessionEvents.InputDiscarded,
  SessionEvents.Closed,
] as const;

/** Structured lifecycle/error logs. Destinations and formatting belong to the host. */
export class LoggerPlugin implements Plugin {
  readonly id = "logger";
  private readonly write: NonNullable<LoggerOptions["write"]>;

  constructor(options: LoggerOptions = {}) {
    this.write = options.write ?? ((entry) => {
      console.error(JSON.stringify(entry));
    });
  }

  setup(tesseract: PluginContext): void {
    for (const name of events)
      tesseract.hook(name, (event) =>
        this.write(
          Object.freeze({
            ...event,
            timestamp: event.timestamp ?? new Date().toISOString(),
            level:
              "error" in event.payload && event.payload.error
                ? "error"
                : event.type === AgentEvents.StreamSuspended
                  ? "warn"
                  : "info",
          }),
        ),
      );
  }
}

export default new LoggerPlugin();
