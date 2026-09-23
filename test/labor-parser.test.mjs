import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaborLeaf } from "../dist/labor-parser.js";

// Regression test: parseLaborLeaf used to match <table>, <tbody>, <tr> only
// when those tags had no attributes at all, so a real LEMON page with e.g.
// <table class="tblLabor"> returned [] silently. Also covers the
// "Combination Procedure" row that switches the active component/operation
// partway through a page's table.

const LEAF_HTML = `
<html><body>
<h1 class="pageTitle">HVAC Door Actuator: Remove &amp; Replace</h1>
<p>Intro text.</p>
<table class="tblLabor" border="1">
<tbody id="rows">
<tr class="row0"><td>All</td><td>Includes function test</td><td>0.5</td><td>0.4</td><td>B</td></tr>
<tr><td colspan="5"><b>Combination Procedure:</b> Blend Door Actuator: Remove &amp; Replace<br>Shares dash disassembly access.</td></tr>
<tr class="row1"><td>All</td><td></td><td>0.3</td><td>0.2</td><td>B</td></tr>
</tbody>
</table>
</body></html>
`;

test("parseLaborLeaf parses tables/rows that carry attributes", () => {
  const rows = parseLaborLeaf(LEAF_HTML);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].component, "HVAC Door Actuator");
  assert.equal(rows[0].operation, "Remove & Replace");
  assert.equal(rows[0].applies_to, "All");
  assert.equal(rows[0].time_hours, 0.5);
  assert.equal(rows[0].warranty_hours, 0.4);
  assert.equal(rows[0].skill_level, "B");
  assert.match(rows[0].notes, /Includes function test/);
});

test("parseLaborLeaf switches component/operation on a Combination Procedure row", () => {
  const rows = parseLaborLeaf(LEAF_HTML);
  assert.equal(rows[1].component, "Blend Door Actuator");
  assert.equal(rows[1].operation, "Remove & Replace");
  assert.equal(rows[1].time_hours, 0.3);
  assert.match(rows[1].notes, /Shares dash disassembly access/);
});

test("parseLaborLeaf returns [] when no table is present", () => {
  assert.deepEqual(parseLaborLeaf("<html><body><h1>Nothing: Here</h1></body></html>"), []);
});
