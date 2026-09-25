import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLegacyQuery } from "../dist/query-alias.js";

// Regression test for #36: old cached tool schemas send "query" instead of
// "keyword"/"year". zod silently drops the unknown key, so the search ran
// unfiltered instead of erroring.

test("resolveLegacyQuery splits a year and keyword out of a combined query", () => {
  assert.deepEqual(resolveLegacyQuery("2015 Civic"), { year: "2015", keyword: "Civic" });
});

test("resolveLegacyQuery finds the year anywhere in the string", () => {
  assert.deepEqual(resolveLegacyQuery("Civic 2015"), { year: "2015", keyword: "Civic" });
});

test("resolveLegacyQuery returns only a keyword when there is no 4-digit year", () => {
  assert.deepEqual(resolveLegacyQuery("F-150 4WD"), { year: undefined, keyword: "F-150 4WD" });
});

test("resolveLegacyQuery returns only a year when there is nothing else", () => {
  assert.deepEqual(resolveLegacyQuery("2015"), { year: "2015", keyword: undefined });
});

test("resolveLegacyQuery collapses leftover whitespace after removing the year", () => {
  assert.deepEqual(resolveLegacyQuery("  2015   Civic  "), { year: "2015", keyword: "Civic" });
});

test("resolveLegacyQuery ignores a non-4-digit number", () => {
  assert.deepEqual(resolveLegacyQuery("V8 350"), { year: undefined, keyword: "V8 350" });
});

test("resolveLegacyQuery returns undefined keyword for an empty string", () => {
  assert.deepEqual(resolveLegacyQuery(""), { year: undefined, keyword: undefined });
});
