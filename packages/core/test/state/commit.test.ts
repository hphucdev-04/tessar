import { expect, it } from "vitest";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
import { CommitCoordinator } from "../../src/state/commit.js";
import { initialBatch } from "../../src/testing/storage-conformance.js";
it("looks up a committed publish after lost acknowledgement instead of publishing twice", async () => {
  const backend = createMemoryBackend();
  const publish = backend.commits.publish;
  let publications = 0;
  backend.commits.publish = async (request) => {
    const result = await publish(request);
    publications++;
    throw Error("lost acknowledgement");
  };
  const lease = await backend.ownership.acquire({
    threadId: "t1",
    ownerToken: "o",
    ttlMs: 60000,
  });
  expect(
    await new CommitCoordinator(backend).commit(initialBatch(), lease),
  ).toMatchObject({ revision: 1 });
  expect(publications).toBe(1);
  await backend.close();
});
it("refuses dangling execution references and mismatched revisions", async () => {
  const backend = createMemoryBackend();
  const batch = initialBatch();
  const lease = await backend.ownership.acquire({
    threadId: "t1",
    ownerToken: "o",
    ttlMs: 60000,
  });
  await expect(
    new CommitCoordinator(backend).commit(
      { ...batch, checkpoint: { ...batch.checkpoint, revision: 8 } },
      lease,
    ),
  ).rejects.toThrow();
  expect(await backend.threads.get("t1")).toBeNull();
  await backend.close();
});
