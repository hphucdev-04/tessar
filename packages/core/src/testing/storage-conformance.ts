import { describe, expect, it } from "vitest";
import type { StorageBackend, CommitBatch } from "../state/storage-ports.js";
import { CommitCoordinator } from "../state/commit.js";
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
    it("rejects publication using another thread's valid lease", async () => {
      const backend = await factory();
      try {
        const a = await backend.ownership.acquire({ threadId: "a", ownerToken: "a", ttlMs: 60000 });
        const b = await backend.ownership.acquire({ threadId: "b", ownerToken: "b", ttlMs: 60000 });
        const batch = initialBatch("b");
        await backend.commits.stage(batch);
        await expect(backend.commits.publish({ commitId: batch.commitId, threadId: "b", expectedRevision: 0, lease: a })).rejects.toMatchObject({ code: "OwnershipLost" });
        expect(await backend.threads.get("b")).toBeNull();
        await expect(new CommitCoordinator(backend).commit(batch, a)).rejects.toMatchObject({ code: "OwnershipLost" });
        expect((await new CommitCoordinator(backend).commit(batch, b)).threadId).toBe("b");
      } finally { await backend.close(); }
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
