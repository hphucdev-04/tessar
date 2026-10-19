import { fail } from "../errors.js";
import { canonicalJson } from "../state/commit.js";
import type { StorageBackend } from "../state/storage-ports.js";
import type { PluginStateSnapshot } from "../state/schema.js";
import type { ModelAttemptRecord } from "../trace/records.js";
import { aggregateUsage } from "../trace/usage.js";
import {
  childStateDefinition,
  type ChildReservation,
} from "./tracked-effects.js";
import type { ExecutionOrigin } from "./frame.js";
export function reservations(
  states: readonly PluginStateSnapshot[],
  streamId: string,
): ChildReservation[] {
  const state = states.find(
    (s) =>
      s.pluginId === "core" &&
      s.namespace === childStateDefinition.namespace &&
      s.ownerType === "stream" &&
      s.ownerId === streamId,
  );
  return state
    ? (Object.values(
        state.data as Record<string, unknown>,
      ) as ChildReservation[])
    : [];
}
async function latestStates(
  backend: StorageBackend,
  threadId: string,
): Promise<readonly PluginStateSnapshot[]> {
  const cp = (await backend.checkpoints.list(threadId))
    .slice()
    .sort((a, b) => a.revision - b.revision)
    .at(-1);
  return cp?.state.pluginStates ?? [];
}
export async function resolveChildAdmission(
  backend: StorageBackend,
  origin: ExecutionOrigin,
  threadId: string,
): Promise<string> {
  const parent = await backend.executions.get("streams", origin.parentStreamId);
  if (!parent) fail("InvalidLineage", "Parent execution not found");
  if (parent.threadId === threadId)
    fail("InvalidLineage", "Child requires a separate Thread");
  const reservation = reservations(
    await latestStates(backend, parent.threadId),
    parent.id,
  ).find((r) => r.origin.dispatchId === origin.dispatchId);
  if (
    !reservation ||
    reservation.threadId !== threadId ||
    canonicalJson(reservation.origin) !== canonicalJson(origin)
  )
    fail("InvalidLineage", "No matching child reservation");
  if (
    await backend.executions.get("streams", reservation.streamId, { threadId })
  )
    fail("AlreadyAdmitted", "Child reservation was already dispatched");
  return reservation.streamId;
}
export async function summarizeStreamUsage(
  backend: StorageBackend,
  streamId: string,
  local?: {
    threadId: string;
    attempts: readonly ModelAttemptRecord[];
    states: readonly PluginStateSnapshot[];
  },
) {
  const root = local
    ? { threadId: local.threadId }
    : await backend.executions.get("streams", streamId);
  if (!root) fail("StreamNotFound", "Execution not found");
  const direct =
    local?.attempts.filter((a) => a.streamId === streamId) ??
    (
      await backend.executions.listRecords("model_attempts", root.threadId)
    ).filter((a) => a.streamId === streamId);
  const attempts: ModelAttemptRecord[] = [...direct],
    seen = new Set<string>([streamId]);
  const queue = reservations(
    local?.states ?? (await latestStates(backend, root.threadId)),
    streamId,
  ).slice();
  while (queue.length) {
    const child = queue.shift()!;
    if (seen.has(child.streamId))
      fail("InvalidLineage", "Cyclic child lineage");
    seen.add(child.streamId);
    const record = await backend.executions.get("streams", child.streamId, {
      threadId: child.threadId,
    });
    if (!record) continue;
    if (record.parentStreamId === null)
      fail("InvalidLineage", "Child is missing parent provenance");
    attempts.push(
      ...(
        await backend.executions.listRecords("model_attempts", child.threadId)
      ).filter((a) => a.streamId === child.streamId),
    );
    queue.push(
      ...reservations(
        await latestStates(backend, child.threadId),
        child.streamId,
      ),
    );
  }
  return {
    direct: aggregateUsage(direct),
    inclusive: aggregateUsage(attempts),
  };
}
