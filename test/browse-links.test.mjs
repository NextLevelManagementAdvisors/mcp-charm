import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinks, computeBrowseEntries, pathSegments } from "../dist/browse-links.js";

// Regression test for #22: native "Repair and Diagnosis" index pages nest
// real content two-plus path segments under plain-text category headers
// ("Electrical" > "Wiring Diagrams" have no <a> of their own; only the leaf
// does). The old isChild() filter (segments.length === parentSegs.length+1)
// silently dropped everything but the one genuine depth+1 link.

const ORIGIN = "https://lemon-manuals.la";
const BASE_URL = `${ORIGIN}/Ford/2011/Econoline%20E350%20Super%20Duty%2C%20Van%20Passenger%2C%205.4%20L%2C%204R75E/Repair%20and%20Diagnosis/`;

const PAGE_HTML = `
<html><body>
<ul>
  <li><a href="External%20Pages/">External Pages</a></li>
  <li>Electrical
    <ul>
      <li>Wiring Diagrams
        <ul>
          <li><a href="Electrical/Wiring%20Diagrams/OEM%20Connector%20End%20Views/">OEM Connector End Views</a></li>
        </ul>
      </li>
      <li><a href="Electrical/Battery%20and%20Charging/">Battery and Charging</a></li>
    </ul>
  </li>
  <li>Brakes
    <ul>
      <li><a href="Brakes/Disc%20Brakes/">Disc Brakes</a></li>
    </ul>
  </li>
</ul>
</body></html>
`;

test("computeBrowseEntries surfaces both real and synthetic categories on nested pages", () => {
  const path = "Ford/2011/Econoline E350 Super Duty, Van Passenger, 5.4 L, 4R75E/Repair and Diagnosis";
  const links = extractLinks(PAGE_HTML, BASE_URL, [ORIGIN]);
  const parentSegs = pathSegments(path);
  const entries = computeBrowseEntries(parentSegs, links);

  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  // Real depth+1 anchor: kept as before, with a real url.
  assert.ok(byName["External Pages"]);
  assert.equal(byName["External Pages"].synthetic, undefined);
  assert.ok(byName["External Pages"].url);

  // "Electrical" itself has no anchor — only deeper links reference it —
  // so it must appear as a synthetic directory entry, not be dropped.
  assert.ok(byName["Electrical"], "Electrical category should be synthesized");
  assert.equal(byName["Electrical"].synthetic, true);
  assert.equal(byName["Electrical"].url, undefined);
  assert.equal(byName["Electrical"].path, `${parentSegs.join("/")}/Electrical`);

  // "Brakes" has a genuine depth+2-only child (Disc Brakes) and no depth+1
  // anchor of its own, so it's synthetic too.
  assert.ok(byName["Brakes"]);
  assert.equal(byName["Brakes"].synthetic, true);

  // Previously this page reported count: 1. Now it should reflect real
  // navigable top-level categories.
  assert.equal(entries.length, 3);
});

test("computeBrowseEntries drills one level deeper into a synthetic category", () => {
  const path = "Ford/2011/Econoline E350 Super Duty, Van Passenger, 5.4 L, 4R75E/Repair and Diagnosis/Electrical";
  const links = extractLinks(PAGE_HTML, BASE_URL, [ORIGIN]);
  const parentSegs = pathSegments(path);
  const entries = computeBrowseEntries(parentSegs, links);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  // "Wiring Diagrams" has no anchor of its own either (only its child does).
  assert.ok(byName["Wiring Diagrams"]);
  assert.equal(byName["Wiring Diagrams"].synthetic, true);

  // "Battery and Charging" has a real anchor exactly one level under Electrical.
  assert.ok(byName["Battery and Charging"]);
  assert.equal(byName["Battery and Charging"].synthetic, undefined);
  assert.ok(byName["Battery and Charging"].url);

  assert.equal(entries.length, 2);
});

test("computeBrowseEntries resolves the real leaf two levels into a synthetic category", () => {
  const path =
    "Ford/2011/Econoline E350 Super Duty, Van Passenger, 5.4 L, 4R75E/Repair and Diagnosis/Electrical/Wiring Diagrams";
  const links = extractLinks(PAGE_HTML, BASE_URL, [ORIGIN]);
  const parentSegs = pathSegments(path);
  const entries = computeBrowseEntries(parentSegs, links);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "OEM Connector End Views");
  assert.equal(entries[0].synthetic, undefined);
  assert.ok(entries[0].url);
});

test("computeBrowseEntries is unchanged for plain depth+1-only pages (no regression)", () => {
  const modelBase = `${ORIGIN}/Ford/2018/`;
  const html = `
    <ul>
      <li><a href="F-150%204WD%20V8-5.0L/">F-150 4WD V8-5.0L</a></li>
      <li><a href="F-250%20Super%20Duty%204WD%20V8-6.2L/">F-250 Super Duty 4WD V8-6.2L</a></li>
    </ul>
  `;
  const path = "Ford/2018";
  const links = extractLinks(html, modelBase, [ORIGIN]);
  const parentSegs = pathSegments(path);
  const entries = computeBrowseEntries(parentSegs, links);

  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.synthetic === undefined && e.url));
});
