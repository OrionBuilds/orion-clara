// Clara's chat endpoint for HER OWN BROWSER UI. Same handlers as /api/chat — different PATH, and
// the path is the entire point.
//
// WHY THIS EXISTS. clara.example.com sits behind two Cloudflare Access applications:
//
//   clara.example.com            → owner-only Access policy (interactive, human)
//   clara.example.com/api/chat   → orion service token (machine; see the OS's clara-chat
//                                        edge function, which sends CF-Access-Client-Id/Secret)
//
// Access routes each request to the MOST SPECIFIC matching application, and each application holds
// its OWN session. Loading /chat authenticates the browser against the domain app and does nothing
// for the /api/chat app — so that second session quietly lapses, and the next message the chat page
// sends is redirected to the Access login screen. A fetch() cannot follow an Access redirect, so it
// surfaces as an opaque CORS failure ("No 'Access-Control-Allow-Origin' header") and the chat says
// "I hit a snag: Failed to fetch". The only thing that renewed it was navigating directly to
// /api/chat, which no normal use of the app ever does. It broke, got fixed by hand, and broke again.
//
// Two audiences were sharing one path. This separates them: the browser posts here and is covered by
// the domain-wide app it already authenticates against, so one page load covers everything it does.
// /api/chat is left untouched for the service-token integration, which needs no browser session and
// is unaffected by any of this.
//
// Deliberately NOT under /api/chat/... — Access path rules match by prefix, so a child path would be
// captured by the same application and change nothing.

export { GET, POST } from "../chat/route";

// Route segment config is per-module and is NOT inherited through a re-export, so these must mirror
// ../chat/route.ts. maxDuration especially: the intent router runs tools inline here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
