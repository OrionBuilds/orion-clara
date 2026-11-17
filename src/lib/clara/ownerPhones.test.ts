// Owner numbers (ownerPhones.ts): both of the owner's cells identify him; delivery goes to the personal
// one when set and falls back to exactly what it used before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerPhoneSet, ownerDeliveryNumber, ownerDeliveryPhoneFromEnv, samePhone, normalizeE164, transferTarget, isLoopNumber } from "./ownerPhones";

test("every configured number identifies the owner, de-duplicated by digits", () => {
  const set = ownerPhoneSet({ OWNER_PHONE: "+16895550100", OWNER_WORK_PHONE: "(689) 555-0100", OWNER_PERSONAL_PHONE: "+18135550111" }, ["+16895550100"]);
  assert.deepEqual(set, ["+16895550100", "+18135550111"]);
});

test("junk values never become an owner number", () => {
  assert.deepEqual(ownerPhoneSet({ OWNER_PERSONAL_PHONE: "123" }, [""]), []);
});

test("delivery prefers the personal cell, normalized", () => {
  assert.equal(ownerDeliveryNumber({ OWNER_PERSONAL_PHONE: "(813) 555-0111", OWNER_PHONE: "+16895550100" }, ["+16895550100"]), "+18135550111");
});

test("an unusable personal number falls through instead of swallowing delivery", () => {
  assert.equal(ownerDeliveryNumber({ OWNER_PERSONAL_PHONE: "123", OWNER_PHONE: "+16895550100" }, ["+16895550100"]), "+16895550100");
  assert.equal(ownerDeliveryPhoneFromEnv({ OWNER_PERSONAL_PHONE: "99+16895550100x", OWNER_PHONE: "+16895550100" }), "+16895550100");
});

test("without a personal cell, delivery is unchanged: config first, then OWNER_PHONE", () => {
  assert.equal(ownerDeliveryNumber({ OWNER_PHONE: "+16895550100" }, ["+16895550999"]), "+16895550999");
  assert.equal(ownerDeliveryNumber({ OWNER_PHONE: "+16895550100" }, []), "+16895550100");
  assert.equal(ownerDeliveryNumber({}, []), undefined);
});

test("the env-only form used by TwiML builders follows the same preference", () => {
  assert.equal(ownerDeliveryPhoneFromEnv({ OWNER_PHONE: "+16895550100", OWNER_PERSONAL_PHONE: "+18135550111" }), "+18135550111");
  assert.equal(ownerDeliveryPhoneFromEnv({ OWNER_PHONE: "+16895550100" }), "+16895550100");
});

test("identity compares the complete number: formatting is ignored, the country code is not", () => {
  assert.equal(samePhone("+1 (689) 555-0100", "6895550100"), true);
  assert.equal(samePhone("16895550100", "+16895550100"), true);
  assert.equal(samePhone("+44 689 555 0100", "+16895550100"), false);
  assert.equal(samePhone("", ""), false);
  assert.equal(samePhone(undefined, undefined), false);
});

test("normalizeE164 accepts US ten/eleven digit and explicit international numbers only", () => {
  assert.equal(normalizeE164("(813) 555-0100"), "+18135550100");
  assert.equal(normalizeE164("+445550100958"), "+445550100958");
  assert.equal(normalizeE164("4155550100"), "+14155550100"); // bare ten digits are read as US
  assert.equal(normalizeE164("+3545550100"), "+3545550100"); // ten-digit international
  assert.equal(normalizeE164("+1689555010"), null); // +1 must be eleven digits
  assert.equal(normalizeE164("12345"), null);
  assert.equal(normalizeE164("813-555-0100 ext 4"), null);
});

// The owner's work phone forwards every call to Clara (*72) and its texts reach her through the Mac.
const WORK = { OWNER_WORK_PHONE: "+16895550100", OWNER_PHONE: "+16895550100", CLARA_WORKLINE_NUMBER: "+18135550199", CLARA_TWILIO_NUMBER: "+18135550000" };

test("a transfer never dials the work phone — it would forward straight back to Clara", () => {
  assert.equal(transferTarget(WORK), undefined); // no personal cell → no transfer at all
  assert.equal(transferTarget({ ...WORK, OWNER_PERSONAL_PHONE: "+16895550100" }), undefined);
  assert.equal(transferTarget({ ...WORK, OWNER_PERSONAL_PHONE: "+18135550199" }), undefined); // Clara's own work line
  assert.equal(transferTarget({ ...WORK, OWNER_PERSONAL_PHONE: "(813) 555-0111" }), "+18135550111");
});

test("owner delivery skips the work phone and Clara's own lines", () => {
  assert.equal(ownerDeliveryNumber(WORK, ["+16895550100"]), undefined);
  assert.equal(ownerDeliveryNumber({ ...WORK, OWNER_PERSONAL_PHONE: "+18135550111" }, ["+16895550100"]), "+18135550111");
  assert.equal(ownerDeliveryPhoneFromEnv(WORK), undefined);
  assert.equal(isLoopNumber(WORK, "6895550100"), true);
  assert.equal(isLoopNumber(WORK, "+18135550111"), false);
});

test("the work phone still identifies the owner", () => {
  assert.ok(ownerPhoneSet({ ...WORK, OWNER_PERSONAL_PHONE: "+18135550111" }, []).includes("+16895550100"));
});
