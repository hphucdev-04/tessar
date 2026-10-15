import snapshot from "./catalog.snapshot.json" with { type: "json" };
import type { ProfilePatch } from "./profile.js";
export interface CatalogSnapshot {
  revision: string;
  fetchedAt: string;
  entries: Record<string, Record<string, ProfilePatch>>;
  source?: string;
}
export const bundledCatalog = snapshot as unknown as CatalogSnapshot;
