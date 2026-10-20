import { describe, expect, it } from "vitest";
import type { StorageBackend, CommitBatch } from "../state/storage-ports.js";
import { CommitCoordinator } from "../state/commit.js";
import { ThreadService } from "../state/threads.js";
import type { RecordEntry } from "../state/schema.js";
export function initialBatch(threadId = "t1"): CommitBatch {
  return {
    commitId: "commit-" + threadId,
    threadId,
    expectedRevision: 0,
    checkpoint: {
      id: "cp-" + threadId,
      threadId,
      parentCheckpointId: null,
      revision: 1,
      schemaVersion: 1,
      createdAt: "2026-10-15T00:00:00.000Z",
      state: {
        scope: { userId: "u" },
        metadata: {},
        instructions: null,
        messages: [],
        pluginStates: [],
      },
      execution: null,
      cause: "ThreadCreated",
    },
    records: [],
  };
}
export function storageConformance(
  name: string,
  factory: () => Promise<StorageBackend>,
): void {
  describe(name, () => {
    it("round-trips tool-result interruptions and suspended/resuming execution records", async () => {
      const backend = await factory();
      try {
        const records: RecordEntry[] = [];
        const batch = { ...initialBatch(), records };
        const lease = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        for (const status of ["suspended", "resuming"] as const) {
          batch.records.push({
            kind: "tool_executions",
            id: status,
            threadId: batch.threadId,
            data: {
              id: status,
              turnId: "turn",
              streamId: "stream",
              scope: {},
              toolCallId: status,
              parentToolExecutionId: null,
              toolName: "ask",
              arguments: {},
              policyDecision: { decision: "allowed" },
              status,
              startedAt: batch.checkpoint.createdAt,
              endedAt: null,
              durationMs: null,
              resultMessageId: null,
              result: null,
              error: null,
              idempotencyKey: null,
              ...(status === "resuming"
                ? { resume: { interruptId: "question", value: "answer" } }
                : {}),
            },
          });
        }
        batch.records.push({
          kind: "interrupts",
          id: "question",
          threadId: batch.threadId,
          data: {
            kind: "tool-result",
            id: "question",
            threadId: batch.threadId,
            streamId: "stream",
            checkpointId: batch.checkpoint.id,
            definitionId: "ask",
            definitionVersion: 1,
            pluginId: "tools",
            payload: { question: "Choose" },
            responseSchema: { type: "string" },
            actionRef: {
              toolExecutionId: "suspended",
              toolName: "ask",
              argumentsDigest: "{}",
            },
            status: "pending",
            response: null,
            resolvedDecision: null,
            createdAt: batch.checkpoint.createdAt,
            resolvedAt: null,
            revision: 1,
          },
        });
        await new CommitCoordinator(backend).commit(batch, lease);
        for (const record of batch.records) {
          expect(
            await backend.executions.get(record.kind, record.id, {
              threadId: batch.threadId,
            }),
          ).toEqual(record.data);
        }
      } finally {
        await backend.close();
      }
    });
    it("rejects checkpoint identity reuse and leaves the other thread unpublished", async () => {
      const backend = await factory();
      try {
        const original = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: original.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(original, lease);
        const conflicting = initialBatch("other");
        conflicting.checkpoint.id = original.checkpoint.id;
        const other = await backend.ownership.acquire({
          threadId: conflicting.threadId,
          ownerToken: "other",
          ttlMs: 60000,
        });
        await expect(
          new CommitCoordinator(backend).commit(conflicting, other),
        ).rejects.toMatchObject({ code: "CommitConflict" });
        expect(await backend.threads.get(conflicting.threadId)).toBeNull();
        expect(await backend.checkpoints.get(original.checkpoint.id)).toEqual(
          original.checkpoint,
        );
      } finally {
        await backend.close();
      }
    });
    it("rejects an idempotent commit receipt requested with different membership", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(batch, lease);
        for (const patch of [{ threadId: "other" }, { expectedRevision: 9 }])
          await expect(
            backend.commits.publish({
              commitId: batch.commitId,
              threadId: batch.threadId,
              expectedRevision: 0,
              lease,
              ...patch,
            }),
          ).rejects.toMatchObject({ code: "CommitConflict" });
      } finally {
        await backend.close();
      }
    });
    it("preserves fencing counters through purge and cannot revive an old same-owner lease", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch(),
          ownerToken = "same-owner";
        const old = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        await new CommitCoordinator(backend).commit(batch, old);
        await backend.ownership.release(old);
        await new ThreadService(backend).delete(batch.threadId);
        const beforePurge = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        await backend.ownership.release(beforePurge);
        await backend.threads.purge(batch.threadId);
        const current = await backend.ownership.acquire({
          threadId: batch.threadId,
          ownerToken,
          ttlMs: 60000,
        });
        expect(current.fencingToken).toBeGreaterThan(beforePurge.fencingToken);
        await expect(backend.ownership.renew(old, 60000)).rejects.toMatchObject(
          { code: "OwnershipLost" },
        );
        await backend.ownership.release(old);
        await expect(
          backend.ownership.renew(current, 60000),
        ).resolves.toMatchObject({ fencingToken: current.fencingToken });
      } finally {
        await backend.close();
      }
    });
    it("rejects publication using another thread's valid lease", async () => {
      const backend = await factory();
      try {
        const a = await backend.ownership.acquire({
          threadId: "a",
          ownerToken: "a",
          ttlMs: 60000,
        });
        const b = await backend.ownership.acquire({
          threadId: "b",
          ownerToken: "b",
          ttlMs: 60000,
        });
        const batch = initialBatch("b");
        await backend.commits.stage(batch);
        await expect(
          backend.commits.publish({
            commitId: batch.commitId,
            threadId: "b",
            expectedRevision: 0,
            lease: a,
          }),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
        expect(await backend.threads.get("b")).toBeNull();
        await expect(
          new CommitCoordinator(backend).commit(batch, a),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
        expect(
          (await new CommitCoordinator(backend).commit(batch, b)).threadId,
        ).toBe("b");
      } finally {
        await backend.close();
      }
    });
    it("keeps staging hidden and publishes one immutable revision idempotently", async () => {
      const backend = await factory();
      try {
        const batch = initialBatch();
        const lease = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "owner",
          ttlMs: 60000,
        });
        await backend.commits.stage(batch);
        expect(await backend.checkpoints.get(batch.checkpoint.id)).toBeNull();
        const coordinator = new CommitCoordinator(backend);
        const receipt = await coordinator.commit(batch, lease);
        expect(receipt.revision).toBe(1);
        expect(await coordinator.commit(batch, lease)).toEqual(receipt);
        expect(await backend.threads.get("t1")).toMatchObject({
          id: "t1",
          revision: 1,
          currentCheckpointId: "cp-t1",
        });
        await expect(
          coordinator.commit(
            {
              ...batch,
              checkpoint: { ...batch.checkpoint, cause: "Terminal" },
            },
            lease,
          ),
        ).rejects.toMatchObject({ code: "CommitConflict" });
      } finally {
        await backend.close();
      }
    });
    it("rejects concurrent ownership and stale fencing tokens", async () => {
      const backend = await factory();
      try {
        const old = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "same-logical-controller/processA",
          ttlMs: 60000,
        });
        await expect(
          backend.ownership.acquire({
            threadId: "t1",
            ownerToken: "same-logical-controller/processB",
            ttlMs: 60000,
          }),
        ).rejects.toMatchObject({ code: "OwnerActive" });
        await backend.ownership.release(old);
        const next = await backend.ownership.acquire({
          threadId: "t1",
          ownerToken: "processB",
          ttlMs: 60000,
        });
        expect(next.fencingToken).toBeGreaterThan(old.fencingToken);
        await backend.commits.stage(initialBatch());
        await expect(
          backend.commits.publish({
            commitId: "commit-t1",
            threadId: "t1",
            expectedRevision: 0,
            lease: old,
          }),
        ).rejects.toMatchObject({ code: "OwnershipLost" });
      } finally {
        await backend.close();
      }
    });
  });
}
