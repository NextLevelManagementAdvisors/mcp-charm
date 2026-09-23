import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findWrapperImageUrls,
  substituteImageUrls,
  extractImageSrc,
  parseDtcTableHtml,
  tokenizeSymptom,
  scoreText,
  relevanceScore,
  extractSnippet,
  IMAGE_EXT_RE,
} from "../dist/diagnosis.js";

// --- #8: image-wrapper URL resolution ---------------------------------------

test("findWrapperImageUrls returns only refs lacking a direct image extension", () => {
  const md = [
    "![diagram](https://lemon-manuals.la/images25/VA344587/)",
    "![already direct](https://lemon-manuals.la/img/photo.png)",
    "![query direct](https://lemon-manuals.la/img/photo.jpg?rev=2)",
    "![wrapper2](https://lemon-manuals.la/images25/ZZ1/)",
    "![dup wrapper](https://lemon-manuals.la/images25/VA344587/)",
  ].join("\n\n");

  const wrappers = findWrapperImageUrls(md);
  assert.deepEqual(wrappers, [
    "https://lemon-manuals.la/images25/VA344587/",
    "https://lemon-manuals.la/images25/ZZ1/",
  ]);
});

test("IMAGE_EXT_RE recognizes direct image files, including with query strings", () => {
  assert.ok(IMAGE_EXT_RE.test("https://x/y.png"));
  assert.ok(IMAGE_EXT_RE.test("https://x/y.JPEG?rev=9"));
  assert.ok(!IMAGE_EXT_RE.test("https://x/images25/VA344587/"));
});

test("substituteImageUrls swaps resolved wrappers and leaves the rest intact", () => {
  const md =
    "![a](https://lemon-manuals.la/images25/VA344587/) and ![b](https://lemon-manuals.la/img/keep.png)";
  const resolved = new Map([
    ["https://lemon-manuals.la/images25/VA344587/", "https://lemon-manuals.la/i/real.png"],
    ["https://lemon-manuals.la/img/keep.png", "https://lemon-manuals.la/img/keep.png"],
  ]);
  const out = substituteImageUrls(md, resolved);
  assert.equal(
    out,
    "![a](https://lemon-manuals.la/i/real.png) and ![b](https://lemon-manuals.la/img/keep.png)"
  );
});

test("extractImageSrc resolves a relative <img src> against the wrapper URL", () => {
  const html = `<html><body><img src="../real/diagram.png" alt="x"></body></html>`;
  assert.equal(
    extractImageSrc(html, "https://lemon-manuals.la/images25/VA344587/"),
    "https://lemon-manuals.la/images25/real/diagram.png"
  );
  assert.equal(extractImageSrc("<html>no image here</html>", "https://lemon-manuals.la/x/"), null);
});

// --- #12: DTC index table parsing -------------------------------------------

const DTC_PAGE = `
<h1>DTC Index</h1>
<table>
  <tr><th>DTC</th><th>Description</th><th>System</th><th>Pinpoint Test</th></tr>
  <tr>
    <td>P0128</td>
    <td>Coolant Thermostat (Coolant Temp Below Regulating Temp)</td>
    <td>Engine Cooling</td>
    <td><a href="../Pinpoint%20Tests/DTC%20P0128/">Go to Pinpoint Test HC</a></td>
  </tr>
  <tr>
    <td>P0171</td>
    <td>System Too Lean (Bank 1)</td>
    <td>Fuel</td>
    <td><a href="../Pinpoint%20Tests/DTC%20P0171/">Go to Pinpoint Test</a></td>
  </tr>
</table>
`;

test("parseDtcTableHtml finds a row and resolves the pinpoint URL", () => {
  const parsed = parseDtcTableHtml(
    DTC_PAGE,
    "https://lemon-manuals.la/Ford/2011/Focus/Repair%20and%20Diagnosis/Powertrain/PCM/DTC%20Index/",
    "p0128"
  );
  assert.ok(parsed);
  assert.equal(parsed.description, "Coolant Thermostat (Coolant Temp Below Regulating Temp)");
  assert.equal(parsed.system_from_table, "Engine Cooling");
  assert.equal(parsed.pinpoint_test_label, "Go to Pinpoint Test HC");
  assert.equal(
    parsed.pinpoint_test_url,
    "https://lemon-manuals.la/Ford/2011/Focus/Repair%20and%20Diagnosis/Powertrain/PCM/Pinpoint%20Tests/DTC%20P0128/"
  );
});

test("parseDtcTableHtml is case-insensitive and returns null for a missing code", () => {
  assert.ok(parseDtcTableHtml(DTC_PAGE, "https://lemon-manuals.la/x/", "P0171"));
  assert.equal(parseDtcTableHtml(DTC_PAGE, "https://lemon-manuals.la/x/", "P9999"), null);
});

test("parseDtcTableHtml falls back to positional columns without a header", () => {
  const noHeader = `<table>
    <tr><td>B1234</td><td>Driver Airbag Circuit Fault</td><td><a href="./PPT/">test</a></td></tr>
  </table>`;
  const parsed = parseDtcTableHtml(noHeader, "https://lemon-manuals.la/a/b/", "B1234");
  assert.ok(parsed);
  assert.equal(parsed.description, "Driver Airbag Circuit Fault");
  assert.equal(parsed.pinpoint_test_url, "https://lemon-manuals.la/a/b/PPT/");
});

// --- #10: symptom scoring ----------------------------------------------------

test("tokenizeSymptom lowercases, strips punctuation, and drops short words", () => {
  assert.deepEqual(tokenizeSymptom("Rear A/C blows hot!"), ["rear", "blows", "hot"]);
  assert.deepEqual(tokenizeSymptom("a to of"), []);
});

test("scoreText counts every token occurrence", () => {
  assert.equal(scoreText("blend door actuator; the door sticks", ["door", "actuator"]), 3);
  assert.equal(scoreText("nothing here", ["door"]), 0);
});

test("relevanceScore is bounded 0..1 and rewards title + content matches", () => {
  const none = relevanceScore(0, 0, 500, 3);
  const some = relevanceScore(9, 20, 500, 3);
  assert.equal(none, 0);
  assert.ok(some > 0 && some <= 1);
});

test("extractSnippet centers on the first matching token", () => {
  const text =
    "Overview section. ".repeat(10) + "The heater blend door actuator failure is common.";
  const snippet = extractSnippet(text, ["blend", "actuator"], 80);
  assert.ok(snippet.includes("blend door actuator"));
  assert.ok(snippet.startsWith("…"));
});
