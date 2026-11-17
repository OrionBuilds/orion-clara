// Clara — the single Google Maps Platform API key.
//
// One key serves three key-based (non-OAuth) Google services Clara uses: Places, Weather, and
// Time Zone. These are distinct from everything in google-auth.ts — no user consent, no per-account
// token, nothing tied to the owner's data. An API key does nothing for Gmail/Drive/Calendar and an OAuth
// token does nothing here; they're separate mechanisms that happen to live in the same GCP project.
//
// The env var was originally named for Places alone, back when that was the only key-based service.
// Reading the Maps-platform name first (falling back to the old one) makes the name honest without
// breaking any existing setup.

// CLARA_GOOGLE_MAPS_API_KEY is the canonical name; the other two are accepted so an existing
// .env.local keeps working without a rename.
export function googleApiKey(): string | undefined {
  return (
    process.env.CLARA_GOOGLE_MAPS_API_KEY
    ?? process.env.CLARA_GOOGLE_PLACES_API_KEY
    ?? process.env.GOOGLE_API
  )?.trim() || undefined;
}

export function googleApiKeyConfigured(): boolean {
  return Boolean(googleApiKey());
}

// Diagnostic for the case where a key IS in .env.local under a name Clara doesn't read. Returns
// VARIABLE NAMES ONLY — never values — so it's safe to surface on the system page. Only meant to
// be shown when the key is unresolved; otherwise it's noise.
export function googleKeyCandidateNames(): string[] {
  return Object.keys(process.env)
    .filter((k) => /GOOGLE/i.test(k) && /(KEY|API|TOKEN|SECRET)/i.test(k))
    .sort();
}
