// Tests for the Drive edit executor's payload validation and the Docs replace pre-check — the two
// pure pieces of the 2026-09-23 fix that let Clara edit the ICP doc. Network paths are not exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDriveEditPayload } from "./ms-files";
// TODO(ms-migration): `missingFinds` has a drop-in match in ms-editors.ts (same signature) and is
// repointed below. `docBodyText`, however, has NO equivalent in ms-editors.ts — it is a pure
// flattener for a parsed Google Docs `documents.get` JSON body (paragraphs/table cells/textRuns),
// and Word has no comparable JSON document model to flatten (ms-editors.ts's docsGetBodyText is
// async, takes a SharePoint file id, and extracts text from the real .docx bytes via mammoth — a
// different signature for a different operation). This is a genuine gap, not a mechanical rename,
// so `docBodyText` stays imported from google-editors.ts (left in place, unused elsewhere) and the
// test below exercising it is unchanged. Flagged in the migration report.
import { docBodyText } from "./google-editors";
import { missingFinds } from "./ms-editors";
import { renderKnownDocuments } from "./knowledge";

test("docs-insert accepts the object shape and the legacy bare string", () => {
  assert.deepEqual(normalizeDriveEditPayload("docs-insert", { text: "hi" }), { ok: true, value: { op: "docs-insert", text: "hi", atIndex: undefined } });
  assert.deepEqual(normalizeDriveEditPayload("docs-insert", "legacy"), { ok: true, value: { op: "docs-insert", text: "legacy", atIndex: undefined } });
  const bad = normalizeDriveEditPayload("docs-insert", { text: "   " });
  assert.equal(bad.ok, false);
});

test("docs-replace rejects a string payload with a clear error instead of throwing", () => {
  const r = normalizeDriveEditPayload("docs-replace", "Roofers");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /find, replace/);
  const empty = normalizeDriveEditPayload("docs-replace", { replacements: [] });
  assert.equal(empty.ok, false);
  const half = normalizeDriveEditPayload("docs-replace", { replacements: [{ find: "", replace: "x" }] });
  assert.equal(half.ok, false);
  const good = normalizeDriveEditPayload("docs-replace", { replacements: [{ find: "a", replace: "b" }] });
  assert.deepEqual(good, { ok: true, value: { op: "docs-replace", replacements: [{ find: "a", replace: "b" }] } });
});

test("sheets-write needs range and rows", () => {
  assert.equal(normalizeDriveEditPayload("sheets-write", { range: "A1", values: "nope" }).ok, false);
  assert.equal(normalizeDriveEditPayload("sheets-write", { range: "", values: [["x"]] }).ok, false);
  assert.equal(normalizeDriveEditPayload("sheets-write", { range: "Sheet1!A1", values: [["x"]], mode: "append" }).ok, true);
});

test("docBodyText flattens paragraphs and table cells the way replaceAllText sees them", () => {
  const doc = {
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: "Roofing\n" } }] } },
        { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "cell\n" } }] } }] }] }] } },
      ],
    },
  };
  assert.equal(docBodyText(doc), "Roofing\ncell\n");
  assert.equal(docBodyText({}), "");
});

test("missingFinds reports finds the doc does not contain (case-sensitive)", () => {
  const body = "Ideal customer: Roofing companies in Florida\n";
  assert.deepEqual(missingFinds(body, [{ find: "Roofing companies" }]), []);
  assert.deepEqual(missingFinds(body, [{ find: "roofing companies" }, { find: "Florida" }, { find: "" }]), ["roofing companies", ""]);
});

test("known-documents block names aliases and ids, and is empty with no sources", () => {
  const block = renderKnownDocuments([{ id: "abc123", title: "ICP doc title", aliases: ["ICP", "ICP doc"] }]);
  assert.match(block, /ICP doc title \(aka ICP, ICP doc\) — file id abc123/);
  assert.match(block, /drive_read/);
  assert.equal(renderKnownDocuments([]), "");
});
