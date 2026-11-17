import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNATURES, type TechSignature } from "./signatures";

function find(name: string): TechSignature {
  const s = SIGNATURES.find((x) => x.name === name);
  assert.ok(s, `no signature named ${name}`);
  return s as TechSignature;
}

const NOISE_HTML = "<html><body><h1>Nothing Here</h1><p>Just a plain page with no third-party tools.</p></body></html>";
const NOISE_SCRIPTS = ["https://example.com/app.js"];

test("every signature in the table has a unique name within its category (no accidental dupes)", () => {
  const seen = new Set<string>();
  for (const s of SIGNATURES) {
    const key = `${s.category}:${s.name}`;
    assert.ok(!seen.has(key), `duplicate signature ${key}`);
    seen.add(key);
  }
});

test("every signature's match() returns false against unrelated noise content", () => {
  for (const s of SIGNATURES) {
    assert.equal(s.match(NOISE_HTML, NOISE_SCRIPTS), false, `${s.name} false-positived on noise`);
  }
});

test("WordPress: wp-content/wp-includes/wp-json markers", () => {
  const s = find("WordPress");
  assert.ok(s.match('<link href="/wp-content/themes/x/style.css">', []));
  assert.ok(s.match('<script src="/wp-includes/js/jquery.js"></script>', []));
  assert.ok(s.match('<link rel="https://api.w.org/" href="https://acme.com/wp-json/">', []));
  assert.equal(s.match(NOISE_HTML, []), false);
});

test("Wix: wix.com/wixstatic.com/_wixCssPreloaded markers", () => {
  const s = find("Wix");
  assert.ok(s.match("", ["https://static.wixstatic.com/sites/x.js"]));
  assert.ok(s.match("<script>var _wixCssPreloaded = true;</script>", []));
});

test("Squarespace: squarespace.com script/host markers", () => {
  const s = find("Squarespace");
  assert.ok(s.match("", ["https://static1.squarespace.com/static/x/y.js"]));
});

test("GoHighLevel: leadconnectorhq.com / msgsndr.com script markers", () => {
  const s = find("GoHighLevel");
  assert.ok(s.match("", ["https://widgets.leadconnectorhq.com/loader.js"]));
  assert.ok(s.match("<script>window.msgsndr = {}</script>", []));
  assert.equal(s.match(NOISE_HTML, NOISE_SCRIPTS), false);
});

test("HubSpot: js.hs-scripts.com / js.hsforms.net script markers", () => {
  const s = find("HubSpot");
  assert.ok(s.match("", ["https://js.hs-scripts.com/1234567.js"]));
  assert.ok(s.match("", ["https://js.hsforms.net/forms/v2.js"]));
});

test("JobNimbus: cdn.jobnimbus.com script marker", () => {
  const s = find("JobNimbus");
  assert.ok(s.match("", ["https://cdn.jobnimbus.com/widget/embed.js"]));
});

test("AccuLynx: best-effort literal 'acculynx' mention", () => {
  const s = find("AccuLynx");
  assert.equal(s.bestEffort, true);
  assert.ok(s.match("<p>Powered by AccuLynx</p>", []));
  assert.ok(s.match("", ["https://app.acculynx.com/widget.js"]));
});

test("ServiceTitan: literal 'servicetitan' mention", () => {
  const s = find("ServiceTitan");
  assert.ok(s.match("", ["https://widget.servicetitan.com/embed.js"]));
});

test("Intercom: widget.intercom.io script marker", () => {
  assert.ok(find("Intercom").match("", ["https://widget.intercom.io/widget/abc123"]));
});

test("Tidio: code.tidio.co script marker", () => {
  assert.ok(find("Tidio").match("", ["https://code.tidio.co/abc123.js"]));
});

test("Drift: js.driftt.com script marker", () => {
  assert.ok(find("Drift").match("", ["https://js.driftt.com/include/abc/123.js"]));
});

test("Hatch: hatch.co / gethatch markers", () => {
  const s = find("Hatch");
  assert.ok(s.match("", ["https://widget.hatch.co/loader.js"]));
  assert.ok(s.match("<script>gethatch.init()</script>", []));
});

test("Calendly: calendly.com marker", () => {
  assert.ok(find("Calendly").match('<iframe src="https://calendly.com/acme/consult"></iframe>', []));
});

test("Housecall Pro: housecallpro.com / bookinglink markers", () => {
  const s = find("Housecall Pro");
  assert.ok(s.match("", ["https://book.housecallpro.com/widget.js"]));
  assert.ok(s.match('<a href="https://booking.example.com/bookinglink/acme">Book now</a>', []));
});

test("CallRail: cdn.callrail.com script marker", () => {
  assert.ok(find("CallRail").match("", ["https://cdn.callrail.com/companies/123/abc/12/swap.js"]));
});

test("Meta Pixel: connect.facebook.net / fbevents.js markers", () => {
  const s = find("Meta Pixel");
  assert.ok(s.match("", ["https://connect.facebook.net/en_US/fbevents.js"]));
});

test("Google Ads: AW-123456789 conversion id pattern, not a bare 'aw-' substring", () => {
  const s = find("Google Ads");
  assert.ok(s.match("<script>gtag('config', 'AW-987654321');</script>", []));
  assert.equal(s.match("<p>the law-abiding claw-foot</p>", []), false);
});

test("Google Analytics / GTM: googletagmanager.com / gtag(/ga( markers", () => {
  const s = find("Google Analytics / GTM");
  assert.ok(s.match("", ["https://www.googletagmanager.com/gtm.js?id=GTM-ABCDEF"]));
  assert.ok(s.match("<script>gtag('js', new Date());</script>", []));
  assert.ok(s.match("<script>ga('create', 'UA-12345-1');</script>", []));
});

test("Google Local Services Ads: best-effort badge host markers", () => {
  const s = find("Google Local Services Ads");
  assert.equal(s.bestEffort, true);
  assert.ok(s.match('<iframe src="https://www.google.com/local-services/badge?...">', []));
});

test("Podium / Birdeye: script markers", () => {
  assert.ok(find("Podium").match("", ["https://cdn.podium.com/widget.js"]));
  assert.ok(find("Birdeye").match("", ["https://web.birdeye.com/widget.js"]));
});

test("Roofr / Hover / CompanyCam: script or html markers, mapped to category 'other'", () => {
  for (const name of ["Roofr", "Hover", "CompanyCam"]) {
    const s = find(name);
    assert.equal(s.category, "other");
  }
  assert.ok(find("Roofr").match("", ["https://app.roofr.com/widget.js"]));
  assert.ok(find("Hover").match('<a href="https://hover.to/measure/acme">Get a 3D model</a>', []));
  assert.ok(find("CompanyCam").match("", ["https://app.companycam.com/embed.js"]));
});

test("Stripe: js.stripe.com script marker", () => {
  assert.ok(find("Stripe").match("", ["https://js.stripe.com/v3/"]));
});

test("financing signatures match BOTH a script-domain hit and a plain-text brand mention", () => {
  const cases: Array<{ name: string; script: string; text: string }> = [
    { name: "GreenSky", script: "https://www.mygreensky.com/widget.js", text: "Ask about financing through GreenSky." },
    { name: "Service Finance", script: "https://www.servicefinance.com/apply.js", text: "We offer Service Finance payment plans." },
    { name: "Hearth", script: "https://www.gethearth.com/widget.js", text: "Financing available via Hearth." },
    { name: "Wisetack", script: "https://www.wisetack.com/widget.js", text: "Pay over time with Wisetack." },
    { name: "Sunlight Financial", script: "https://www.sunlightfinancial.com/apply.js", text: "Solar financing by Sunlight Financial." },
    { name: "Acorn Finance", script: "https://www.acornfinance.com/widget.js", text: "Get pre-qualified with Acorn Finance." },
  ];
  for (const c of cases) {
    const s = find(c.name);
    assert.equal(s.category, "financing");
    assert.ok(s.match("", [c.script]), `${c.name} should match its script domain`);
    assert.ok(s.match(c.text, []), `${c.name} should match its plain-text brand mention`);
  }
});
