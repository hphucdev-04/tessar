import { storageConformance } from "../../src/testing/storage-conformance.js";
import { createMemoryBackend } from "../../src/state/memory-backend.js";
storageConformance("memory backend",async()=>createMemoryBackend());
