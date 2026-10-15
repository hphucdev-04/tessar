import { storageConformance } from "../testing/storage-conformance.js";
import { createMemoryBackend } from "./memory-backend.js";
storageConformance("memory backend",async()=>createMemoryBackend());
