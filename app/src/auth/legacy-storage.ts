// The SPA kept a bearer token here in an old version and removes it at boot
// (web/src/App.tsx). AGENTS.md: keep that removal until the old SPA is retired.
// This frontend takes over the same origin, so it has to remove it too, or the
// entry outlives the SPA. Bearer material never enters browser storage.
export const LEGACY_BEARER_TOKEN_KEY = "reading-lite.bearerToken";

export function dropLegacyBearerToken(): void {
  try {
    window.localStorage.removeItem(LEGACY_BEARER_TOKEN_KEY);
  } catch {
    // Storage unavailable (private modes, blocked site data).
  }
}
