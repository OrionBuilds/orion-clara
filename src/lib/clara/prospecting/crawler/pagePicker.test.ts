import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPages } from "./pagePicker";

test("picks home plus the 5 canonical pages, capped at 6 total", () => {
  const pages = pickPages("acme.com");
  assert.equal(pages.length, 6);
  assert.deepEqual(pages, [
    "https://acme.com/",
    "https://acme.com/about",
    "https://acme.com/contact",
    "https://acme.com/services",
    "https://acme.com/team",
    "https://acme.com/careers",
  ]);
});

test("a bare domain defaults to https, matching an already-slashed https:// URL", () => {
  assert.deepEqual(pickPages("acme.com"), pickPages("https://acme.com/"));
});

test("an explicit http:// scheme is preserved rather than upgraded", () => {
  const pages = pickPages("http://acme.com");
  assert.equal(pages[0], "http://acme.com/");
  assert.ok(pages.every((p) => p.startsWith("http://acme.com")));
});

test("never returns more than 6 pages", () => {
  const pages = pickPages("acme.com");
  assert.ok(pages.length <= 6);
});

test("a discovered link matching a known path wins over the blind canonical guess", () => {
  const pages = pickPages("acme.com", ["https://acme.com/about-us", "https://acme.com/contact-us"]);
  assert.ok(pages.includes("https://acme.com/about-us"));
  assert.ok(pages.includes("https://acme.com/contact-us"));
  assert.ok(!pages.includes("https://acme.com/about"));
  assert.ok(!pages.includes("https://acme.com/contact"));
});

test("dedupes a discovered link that normalizes to the same path as another pick", () => {
  const pages = pickPages("acme.com", ["https://acme.com/about/", "https://acme.com/about?utm=1"]);
  const aboutPages = pages.filter((p) => p.includes("about"));
  assert.equal(aboutPages.length, 1);
});

test("ignores discovered links from a different origin", () => {
  const pages = pickPages("acme.com", ["https://not-acme.com/about-us"]);
  assert.ok(pages.includes("https://acme.com/about"));
  assert.ok(!pages.some((p) => p.includes("not-acme.com")));
});

test("an invalid base URL returns no pages", () => {
  assert.deepEqual(pickPages(""), []);
  assert.deepEqual(pickPages("   "), []);
});

test("ignores unusable discovered link strings without throwing", () => {
  const pages = pickPages("acme.com", ["not a url", ""]);
  assert.equal(pages.length, 6);
});
