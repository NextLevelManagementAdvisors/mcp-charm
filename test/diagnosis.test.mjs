import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findWrapperImageUrls,
  substituteImageUrls,
  extractImageSrc,
  parseDtcTableHtml,
  dtcIndexHasRows,
  findDtcLinksOnSinglePage,
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

// --- #35: Honda "DTC Index" folder-of-sub-pages fixtures --------------------
// Modeled on the 2015 Honda Civic LX, 4D Sedan, Automatic CVT Trans manual:
// "Quick Lookups/DTC Index (Except Hybrid)" is a plain folder of per-system
// sub-pages (no table of its own), and P0420 only shows up split by engine
// code under "Repair and Diagnosis (Single Page)".

const HONDA_CIVIC_DTC_INDEX_FOLDER = `
<h1>DTC Index (Except Hybrid)</h1>
<ul>
  <li><a href="Engine%20Control%20%2F%20Transmission%20Control%20Systems%20DTCS/">Engine Control / Transmission Control Systems DTCS</a></li>
  <li><a href="Climate%20Control%20System%20DTCS/">Climate Control System DTCS</a></li>
  <li><a href="Body%20Electrical%20System%20DTCS/">Body Electrical System DTCS</a></li>
</ul>
`;

const HONDA_CIVIC_ENGINE_CONTROL_DTCS = `
<h1>Engine Control / Transmission Control Systems DTCS</h1>
<table>
  <tr><th>DTC</th><th>Description</th><th>System</th><th>Pinpoint Test</th></tr>
  <tr>
    <td>P0301</td>
    <td>Cylinder 1 Misfire Detected</td>
    <td>Engine Control</td>
    <td><a href="../../Troubleshooting/DTC%20P0301/">Go to Pinpoint Test</a></td>
  </tr>
  <tr>
    <td>P0420</td>
    <td>Catalyst System Efficiency Below Threshold</td>
    <td>Engine Control</td>
    <td><a href="../../Troubleshooting/DTC%20P0420%3A%20Catalyst%20System%20Efficiency%20Below%20Threshold%20(K24Z7)/">Go to Pinpoint Test</a></td>
  </tr>
</table>
`;

const HONDA_CIVIC_SINGLE_PAGE = `
<h1>Repair and Diagnosis (Single Page)</h1>
<ul>
  <li><a href="Engine%20Performance/System/Engine%20Control%20System%20-%20Diagnostic%20Codes%20(P0365-P0641)%20(Except%20Hybrid)/Troubleshooting/DTC%20P0420%3A%20Catalyst%20System%20Efficiency%20Below%20Threshold%20(K24Z7)/">DTC P0420: Catalyst System Efficiency Below Threshold (K24Z7)</a></li>
  <li><a href="Engine%20Performance/System/Engine%20Control%20System%20-%20Diagnostic%20Codes%20(P0365-P0641)%20(Except%20Hybrid)/Troubleshooting/DTC%20P0420%3A%20Catalyst%20System%20Efficiency%20Below%20Threshold%20(Except%20K24Z7)/">DTC P0420: Catalyst System Efficiency Below Threshold (Except K24Z7)</a></li>
  <li><a href="Engine%20Performance/System/Engine%20Control%20System%20-%20Diagnostic%20Codes%20(P0442-P0457)%20(Except%20Hybrid)/Troubleshooting/DTC%20P0442%3A%20EVAP%20Control%20System%20Leak%20Detected%20(Small%20Leak)/">DTC P0442: EVAP Control System Leak Detected (Small Leak)</a></li>
</ul>
`;

test("dtcIndexHasRows is false for a folder-of-sub-pages DTC Index page (Honda Civic)", () => {
  assert.equal(dtcIndexHasRows(HONDA_CIVIC_DTC_INDEX_FOLDER), false);
});

test("dtcIndexHasRows is true for a page whose table actually contains DTC rows", () => {
  assert.equal(dtcIndexHasRows(HONDA_CIVIC_ENGINE_CONTROL_DTCS), true);
});

test("parseDtcTableHtml finds P0420 once the per-system sub-page is fetched (cheap fix)", () => {
  const parsed = parseDtcTableHtml(
    HONDA_CIVIC_ENGINE_CONTROL_DTCS,
    "https://lemon-manuals.la/Honda/2015/Civic%20LX%2C%204D%20Sedan%2C%20Automatic%20CVT%20Trans/Repair%20and%20Diagnosis/Quick%20Lookups/DTC%20Index%20(Except%20Hybrid)/Engine%20Control%20%2F%20Transmission%20Control%20Systems%20DTCS/",
    "P0420"
  );
  assert.ok(parsed);
  assert.equal(parsed.description, "Catalyst System Efficiency Below Threshold");
  assert.match(
    decodeURIComponent(parsed.pinpoint_test_url),
    /DTC P0420: Catalyst System Efficiency Below Threshold \(K24Z7\)\/$/
  );
});

test("findDtcLinksOnSinglePage matches every per-variant folder for a code, case-insensitively", () => {
  const links = [
    {
      segments: [
        "Honda", "2015", "Civic LX, 4D Sedan, Automatic CVT Trans", "Repair and Diagnosis (Single Page)",
        "Engine Performance", "System", "Engine Control System - Diagnostic Codes (P0365-P0641) (Except Hybrid)",
        "Troubleshooting", "DTC P0420: Catalyst System Efficiency Below Threshold (K24Z7)",
      ],
      url: "https://lemon-manuals.la/Honda/2015/.../DTC%20P0420%3A%20Catalyst%20System%20Efficiency%20Below%20Threshold%20(K24Z7)/",
    },
    {
      segments: [
        "Honda", "2015", "Civic LX, 4D Sedan, Automatic CVT Trans", "Repair and Diagnosis (Single Page)",
        "Engine Performance", "System", "Engine Control System - Diagnostic Codes (P0365-P0641) (Except Hybrid)",
        "Troubleshooting", "DTC P0420: Catalyst System Efficiency Below Threshold (Except K24Z7)",
      ],
      url: "https://lemon-manuals.la/Honda/2015/.../DTC%20P0420%3A%20Catalyst%20System%20Efficiency%20Below%20Threshold%20(Except%20K24Z7)/",
    },
    {
      segments: [
        "Honda", "2015", "Civic LX, 4D Sedan, Automatic CVT Trans", "Repair and Diagnosis (Single Page)",
        "Engine Performance", "System", "Engine Control System - Diagnostic Codes (P0442-P0457) (Except Hybrid)",
        "Troubleshooting", "DTC P0442: EVAP Control System Leak Detected (Small Leak)",
      ],
      url: "https://lemon-manuals.la/Honda/2015/.../DTC%20P0442%3A%20EVAP%20Control%20System%20Leak%20Detected%20(Small%20Leak)/",
    },
  ];

  const matches = findDtcLinksOnSinglePage(links, "p0420");
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.label.startsWith("DTC P0420")));
  assert.ok(matches[0].url.includes("K24Z7"));
  assert.ok(matches[1].url.includes("Except%20K24Z7"));

  assert.equal(findDtcLinksOnSinglePage(links, "P9999").length, 0);
});

test("findDtcLinksOnSinglePage does not partial-match a different code with the same prefix", () => {
  const links = [
    { segments: ["DTC P04200: Some Other Code"], url: "https://x/a/" },
    { segments: ["DTC P0420-A Variant Note"], url: "https://x/b/" },
  ];
  const matches = findDtcLinksOnSinglePage(links, "P0420");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, "DTC P0420-A Variant Note");
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
