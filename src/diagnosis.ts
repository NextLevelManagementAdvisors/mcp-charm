// Pure, network-free helpers backing the diagnosis-oriented tools
// (lookup_dtc, search_diagnosis) and the image-URL resolution in
// get_manual_content. Kept here so the parsing/scoring logic can be unit
// tested without hitting the network (see test/diagnosis.test.mjs).

import { decodeEntities } from "./browse-links.js";

// URLs whose path already ends in a real image extension are direct image
// files; anything else in an ![...](url) reference is an HTML wrapper page we
// need to resolve to the underlying image (see #7/#8).
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)(\?.*)?$/i;

// Collect the distinct image-reference URLs in a markdown blob that do NOT
// already point at a direct image file. These are the wrapper pages worth
// fetching and resolving.
export function findWrapperImageUrls(markdown: string): string[] {
  const re = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const url = m[1].trim();
    if (!IMAGE_EXT_RE.test(url) && !seen.has(url)) seen.add(url);
  }
  return [...seen];
}

// Substitute resolved direct-image URLs back into the markdown. `resolved`
// maps a wrapper URL to its direct image URL; entries that did not change (or
// are missing) leave the original reference untouched.
export function substituteImageUrls(markdown: string, resolved: Map<string, string>): string {
  return markdown.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (full, alt, url) => {
    const direct = resolved.get(String(url).trim());
    return direct && direct !== String(url).trim() ? `![${alt}](${direct})` : full;
  });
}

// Extract the direct image URL from an image-wrapper page's HTML, resolved
// against the wrapper's own URL. Returns null when no image tag is found.
export function extractImageSrc(html: string, wrapperUrl: string): string | null {
  const m = html.match(/<img[^>]+src=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|bmp)[^"']*)["']/i);
  if (!m) return null;
  try {
    return new URL(decodeEntities(m[1]), wrapperUrl).toString();
  } catch {
    return null;
  }
}

// --- DTC index table parsing -------------------------------------------------

export interface ParsedDtcRow {
  description: string;
  system_from_table: string;
  pinpoint_test_label: string;
  pinpoint_test_url: string;
}

function cellText(html: string): string {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseCells(tr: string): string[] {
  return [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
}

// Parse the DTC index tables on a LEMON "DTC Index" page (HTML) and return the
// row matching `targetDtc` (case-insensitive). Column roles are inferred from
// the header row when present (description/condition, system/subsystem,
// pinpoint), falling back to positional defaults (2nd column = description,
// last column = pinpoint test). The pinpoint URL is taken from the <a> in the
// pinpoint cell, resolved against `baseUrl`.
export function parseDtcTableHtml(
  html: string,
  baseUrl: string,
  targetDtc: string
): ParsedDtcRow | null {
  const target = targetDtc.toUpperCase().trim();
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];

  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const firstRow = rows[0];
    if (!firstRow) continue;

    const headers = parseCells(firstRow).map((c) => cellText(c).toLowerCase());
    const headerLooksReal = headers.some((h) =>
      /dtc|code|description|condition|system|pinpoint/.test(h)
    );
    const dataRows = headerLooksReal ? rows.slice(1) : rows;

    const idxOf = (needles: string[]): number => {
      for (const needle of needles) {
        const i = headers.findIndex((h) => h.includes(needle));
        if (i >= 0) return i;
      }
      return -1;
    };
    const descIdx = idxOf(["description", "condition"]);
    const sysIdx = idxOf(["system", "subsystem"]);
    const ptIdx = idxOf(["pinpoint"]);

    for (const tr of dataRows) {
      const cellsHtml = parseCells(tr);
      if (cellsHtml.length === 0) continue;
      const cellsText = cellsHtml.map(cellText);
      if ((cellsText[0] ?? "").toUpperCase().trim() !== target) continue;

      const description =
        descIdx >= 0 && descIdx < cellsText.length
          ? cellsText[descIdx]
          : cellsText[1] ?? "";
      const system = sysIdx >= 0 && sysIdx < cellsText.length ? cellsText[sysIdx] : "";

      const ptCellIdx = ptIdx >= 0 && ptIdx < cellsHtml.length ? ptIdx : cellsHtml.length - 1;
      const ptCellHtml = cellsHtml[ptCellIdx] ?? "";
      const linkMatch = ptCellHtml.match(
        /<a\s+[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/i
      );

      let pinpointLabel = cellText(ptCellHtml);
      let pinpointUrl = "";
      if (linkMatch) {
        try {
          pinpointUrl = new URL(decodeEntities(linkMatch[1]), baseUrl).toString();
        } catch {
          pinpointUrl = "";
        }
        const linkText = cellText(linkMatch[2]);
        if (linkText) pinpointLabel = linkText;
      }

      return {
        description,
        system_from_table: system,
        pinpoint_test_label: pinpointLabel,
        pinpoint_test_url: pinpointUrl,
      };
    }
  }

  return null;
}

// --- Honda-style "DTC Index" folder pages (#35) ------------------------------

// A DTC code cell always looks like a bare code: "P0420", "B1242", "U0100".
const DTC_CODE_CELL_RE = /^[PBCU][0-9A-Za-z]{4}$/i;

// Whether a "DTC Index" page's tables contain at least one row that looks
// like a real DTC code entry, regardless of which code. Some manufacturers
// (Honda) render a "DTC Index" page that's actually just a folder of links
// to per-system sub-pages (e.g. "Engine Control / Transmission Control
// Systems DTCS"), with no code table of its own -- the real tables live one
// level down. Callers use this to tell the two apart and fall back to
// fetching the linked sub-pages instead of reporting a false "not found".
export function dtcIndexHasRows(html: string): boolean {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    for (const tr of rows) {
      const cells = parseCells(tr);
      if (cells.length === 0) continue;
      if (DTC_CODE_CELL_RE.test(cellText(cells[0]))) return true;
    }
  }
  return false;
}

export interface SinglePageDtcMatch {
  label: string;
  url: string;
  path: string;
}

// Some manufacturers (Honda) never list a code in any DTC Index table at
// all -- it only shows up as a pinpoint-test folder name under the "Repair
// and Diagnosis (Single Page)" listing, split one folder per engine/system
// variant (e.g. "DTC P0420: ... (K24Z7)" vs. "... (Except K24Z7)"). Match
// links whose last path segment names the code directly ("DTC P0420: ...",
// "DTC P0420 - ...", "DTC P0420 ..."), and return every match rather than
// just the first, since a single code can legitimately have several
// variant-specific pinpoint tests.
export function findDtcLinksOnSinglePage(
  links: { segments: string[]; url: string }[],
  targetDtc: string
): SinglePageDtcMatch[] {
  const code = targetDtc.toUpperCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^dtc\\s+${code}(?:[:\\-]|\\s|$)`, "i");
  return links
    .filter((l) => re.test((l.segments[l.segments.length - 1] ?? "").trim()))
    .map((l) => ({
      label: l.segments[l.segments.length - 1],
      url: l.url,
      path: l.segments.join("/"),
    }));
}

// --- Symptom scoring (search_diagnosis) --------------------------------------

// Tokenize a plain-language symptom into searchable keyword tokens, dropping
// punctuation and short stop-words.
export function tokenizeSymptom(symptomText: string): string[] {
  return symptomText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// Count total occurrences of every token within `text` (case-insensitive).
export function scoreText(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    let idx = lower.indexOf(token);
    while (idx !== -1) {
      score++;
      idx = lower.indexOf(token, idx + token.length);
    }
  }
  return score;
}

// Composite 0.0–1.0 relevance: title-token match (weight 0.5) + raw content
// hits (0.3) + keyword density (0.2).
export function relevanceScore(
  titleScore: number,
  contentHits: number,
  contentWordCount: number,
  tokenCount: number
): number {
  const density = contentHits / Math.max(1, contentWordCount);
  const raw =
    (titleScore / Math.max(1, tokenCount * 3)) * 0.5 +
    Math.min(1, contentHits / Math.max(1, tokenCount * 5)) * 0.3 +
    Math.min(1, density * 500) * 0.2;
  return Math.round(Math.min(1, raw) * 100) / 100;
}

// Pull a readable snippet centered on the first symptom-token hit in the text.
export function extractSnippet(text: string, tokens: string[], maxLen = 220): string {
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const lower = cleaned.toLowerCase();
  let bestIdx = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }

  const start = bestIdx === -1 ? 0 : Math.max(0, bestIdx - 60);
  const raw = cleaned.slice(start, start + maxLen).trim();
  return (start > 0 ? "…" : "") + raw + (raw.length >= maxLen ? "…" : "");
}
