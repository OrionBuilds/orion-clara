import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnerCc } from "./ownerCc";

const OWNER = "jordan@example.com";

test("owner is CC'd on mail to someone else", () => {
  assert.equal(withOwnerCc("info@acme.example", undefined, OWNER), OWNER);
});

test("owner is appended to an existing cc", () => {
  assert.equal(withOwnerCc("info@acme.example", "ops@acme.example", OWNER), `ops@acme.example, ${OWNER}`);
});

test("no duplicate when the owner is already the recipient or already cc'd (any case, display-name form)", () => {
  assert.equal(withOwnerCc("Jordan@Example.com", undefined, OWNER), undefined);
  assert.equal(withOwnerCc("a@x.com, Jordan Example <jordan@example.com>", undefined, OWNER), undefined);
  assert.equal(withOwnerCc("a@x.com", "JORDAN@example.com", OWNER), "JORDAN@example.com");
});

test("no owner configured → cc unchanged", () => {
  assert.equal(withOwnerCc("a@x.com", "b@x.com", ""), "b@x.com");
  assert.equal(withOwnerCc("a@x.com", undefined, ""), undefined);
});
