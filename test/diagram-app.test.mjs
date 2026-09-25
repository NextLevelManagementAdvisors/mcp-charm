import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFigures } from "../dist/diagram-app.js";

// --- #38: blank captions for trailing-slash image URLs ----------------------

test("extractFigures drops the trailing slash so the resource id is used as the caption, not blank", () => {
  const html = [
    '<img src="/images25/VA467934/">',
    '<img src="/images25/VA467935/">',
  ].join("\n");

  const figures = extractFigures(html, "https://lemon-manuals.la/manual/page/");
  assert.equal(figures.length, 2);
  assert.equal(figures[0].caption, "VA467934");
  assert.equal(figures[1].caption, "VA467935");
});

test("extractFigures falls back to Figure N when there is no path segment at all", () => {
  const html = '<img src="/">';
  const figures = extractFigures(html, "https://lemon-manuals.la/manual/page/");
  assert.equal(figures.length, 1);
  assert.equal(figures[0].caption, "Figure 1");
});

test("extractFigures still derives a caption from the filename when there is no trailing slash", () => {
  const html = '<img src="/images25/VA467934/photo.jpg">';
  const figures = extractFigures(html, "https://lemon-manuals.la/manual/page/");
  assert.equal(figures.length, 1);
  assert.equal(figures[0].caption, "photo.jpg");
});

test("extractFigures prefers alt text over the filename fallback", () => {
  const html = '<img src="/images25/VA467934/" alt="Air Conditioning Wiring">';
  const figures = extractFigures(html, "https://lemon-manuals.la/manual/page/");
  assert.equal(figures.length, 1);
  assert.equal(figures[0].caption, "Air Conditioning Wiring");
});
