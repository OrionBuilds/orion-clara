// Tests for Clara's host gate: Cloudflare Access JWT verification + the two trust headers it manages
// (x-agent-access-verified, the cross-agent marker; and x-clara-principal, Clara's identity header).
// Both are the route-level trust boundary, so these pin the properties that matter:
//   1. a client-supplied copy of EITHER header is STRIPPED before anything else (never survives),
//   2. the access marker is SET ("1") ONLY after real JWKS verification succeeds, and
//   3. the principal is SET ("owner") ONLY for a loopback-local request or a verified owner — and
//      never on a Twilio/OAuth public path.
//
// A mock JWKS (a locally generated RSA key served at the team's /cdn-cgi/access/certs URL) mints
// genuinely-signed tokens without touching Cloudflare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const MARKER = "x-agent-access-verified";
const PRINCIPAL = "x-clara-principal";
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

// Env must be set BEFORE hostGate is imported (it reads these at module scope).
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
process.env.CF_ACCESS_AUD = AUD;

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };

// Intercept the JWKS fetch so createRemoteJWKSet resolves our local public key.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === CERTS_URL) {
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// Import AFTER env + fetch mock are in place.
const { evaluateGate } = await import("./hostGate");

function validJwt(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
const h = (headers: Record<string, string>) => new Headers(headers);
const PATH = "/api/chat"; // a gated (non-public) path

test("valid JWT: allowed; forged marker → '1' and forged principal → 'owner'", async () => {
  const jwt = await validJwt();
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "clara.example.com", "cf-access-jwt-assertion": jwt, [MARKER]: "forged", [PRINCIPAL]: "intruder" }),
    PATH,
  );
  assert.equal(allow, true, "a verified Access request must be allowed");
  assert.equal(forwardHeaders.get(MARKER), "1", "marker must be '1' after JWKS success — the forged value must not survive");
  assert.equal(forwardHeaders.get(PRINCIPAL), "owner", "a verified owner request must resolve to 'owner', not the forged principal");
});

test("forged marker + unverifiable JWT (non-loopback, gated): rejected; neither header set", async () => {
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "clara.example.com", "cf-access-jwt-assertion": "forged.jwt.value", [MARKER]: "1", [PRINCIPAL]: "owner" }),
    PATH,
  );
  assert.equal(allow, false, "an unverifiable Access assertion must be blocked");
  assert.equal(forwardHeaders.get(MARKER), null, "a rejected request must not carry the marker");
  assert.equal(forwardHeaders.get(PRINCIPAL), null, "a rejected request must not carry a principal");
});

test("forged headers alone (no JWT, non-loopback, gated): rejected — presence never grants trust", async () => {
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "clara.example.com", [MARKER]: "1", [PRINCIPAL]: "owner" }),
    PATH,
  );
  assert.equal(allow, false, "client-set trust headers with no verified Access must be blocked");
  assert.equal(forwardHeaders.get(MARKER), null, "the client-supplied marker must have been stripped");
  assert.equal(forwardHeaders.get(PRINCIPAL), null, "the client-supplied principal must have been stripped");
});

test("loopback host: allowed; forged marker stripped, principal resolved to 'owner' (local dashboard)", async () => {
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "127.0.0.1:3939", [MARKER]: "forged", [PRINCIPAL]: "intruder" }),
    PATH,
  );
  assert.equal(allow, true, "loopback must be allowed");
  assert.equal(forwardHeaders.get(MARKER), null, "loopback must not carry a client-supplied access marker (stripped, never set here)");
  assert.equal(forwardHeaders.get(PRINCIPAL), "owner", "loopback dashboard resolves to 'owner', overriding any forged principal");
});

test("Twilio public path off-loopback: allowed (webhook); no principal, forged headers stripped", async () => {
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "clara.example.com", [MARKER]: "1", [PRINCIPAL]: "owner" }),
    "/api/channels/twilio/sms",
  );
  assert.equal(allow, true, "a Twilio webhook public path must be reachable");
  assert.equal(forwardHeaders.get(MARKER), null, "public path must not carry a client-supplied marker");
  assert.equal(forwardHeaders.get(PRINCIPAL), null, "Twilio webhooks authenticate themselves and must never receive a principal");
});

test("OAuth callback off-loopback: allowed; no principal stamped", async () => {
  const { allow, forwardHeaders } = await evaluateGate(
    h({ host: "clara.example.com", [PRINCIPAL]: "owner" }),
    "/api/google/callback",
  );
  assert.equal(allow, true, "the OAuth callback must be reachable off-loopback");
  assert.equal(forwardHeaders.get(PRINCIPAL), null, "the OAuth callback must not receive a client-asserted principal");
});

test("the hold-transfer webhooks and the hold audio are public paths (Twilio has no Access assertion)", async () => {
  for (const p of ["wait", "done", "return", "answer", "bridged", "owner-done", "owner-status"]) {
    const { allow, forwardHeaders } = await evaluateGate(new Headers({ host: "clara.example.com", [MARKER]: "1", [PRINCIPAL]: "owner" }), `/api/channels/twilio/voice/hold/${p}`);
    assert.equal(allow, true, p);
    assert.equal(forwardHeaders.get(PRINCIPAL), null, p);
  }
  const audio = await evaluateGate(new Headers({ host: "clara.example.com" }), "/api/channels/twilio/hold-audio");
  assert.equal(audio.allow, true);
  assert.equal(audio.forwardHeaders.get(PRINCIPAL), null);
});
