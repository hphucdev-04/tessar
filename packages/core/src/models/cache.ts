import type { ModelProfile } from "./profile.js";
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
export class ProfileCache {
  private readonly values = new Map<
    string,
    { profile: ModelProfile; fetchedAt: number }
  >();
  key(
    provider: string,
    model: string,
    endpoint: string,
    partition: string,
  ): string {
    return JSON.stringify([provider, model, endpoint, partition]);
  }
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, profile: ModelProfile, fetchedAt: number) {
    this.values.set(key, { profile, fetchedAt });
  }
  clear() {
    this.values.clear();
  }
}
