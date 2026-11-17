import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "./htmlToText";

test("strips tags down to readable text", () => {
  const { text } = htmlToText("<html><body><p>Hello <b>world</b></p></body></html>");
  assert.ok(text.includes("Hello world"));
  assert.ok(!text.includes("<"));
});

test("keeps headings as recognizable structure, prefixed by level", () => {
  const html = "<h1>About Us</h1><p>We roof things.</p><h2>Our Team</h2>";
  const { text } = htmlToText(html);
  assert.ok(text.includes("# About Us"));
  assert.ok(text.includes("## Our Team"));
});

test("keeps mailto: and tel: links recoverable, inline and via the footer+links array", () => {
  const html = `<a href="mailto:owner@acme.com">Email us</a> <a href="tel:+18135550100">Call</a>`;
  const { text, links } = htmlToText(html);
  assert.ok(text.includes("mailto:owner@acme.com"));
  assert.ok(text.includes("tel:+18135550100"));
  assert.ok(text.includes("Email us"));
  assert.equal(links.find((l) => l.href === "mailto:owner@acme.com")?.text, "Email us");
  assert.equal(links.find((l) => l.href === "tel:+18135550100")?.text, "Call");
});

test("keeps regular http(s) links recoverable", () => {
  const html = `<a href="https://acme.com/services">Services</a>`;
  const { text, links } = htmlToText(html);
  assert.ok(text.includes("https://acme.com/services"));
  assert.equal(links[0].href, "https://acme.com/services");
  assert.equal(links[0].text, "Services");
});

test("an icon-only (empty visible text) anchor still keeps its href via the footer", () => {
  const html = `<a href="mailto:hello@acme.com"><i class="icon-mail"></i></a>`;
  const { text, links } = htmlToText(html);
  assert.ok(text.includes("mailto:hello@acme.com"));
  assert.equal(links[0].href, "mailto:hello@acme.com");
});

test("drops script/style content entirely rather than flattening it into text", () => {
  const html = "<script>var secret=1;</script><style>.a{color:red}</style><p>Visible</p>";
  const { text } = htmlToText(html);
  assert.ok(text.includes("Visible"));
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("color:red"));
});

test("decodes common HTML entities", () => {
  const { text } = htmlToText("<p>Roofing &amp; Repair &mdash; Tampa&#39;s best</p>");
  assert.ok(text.includes("Roofing & Repair"));
  assert.ok(text.includes("Tampa's best"));
});

test("empty/whitespace-only input yields empty output", () => {
  assert.deepEqual(htmlToText(""), { text: "", links: [] });
  assert.deepEqual(htmlToText("   "), { text: "", links: [] });
});
