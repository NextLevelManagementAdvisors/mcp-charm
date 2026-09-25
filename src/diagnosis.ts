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

// The "Single Page" listing renders the whole Repair and Diagnosis subtree
// under one folder named "Repair and Diagnosis (Single Page)", but that
// folder doesn't exist as its own page -- everything under it is also
// reachable under the plain "Repair and Diagnosis" tree. Rewrite that one
// segment so returned `path` values stay consistent with what browse_manuals
// and get_manual_content otherwise report (#41).
function normalizeSinglePagePath(segments: string[]): string {
  return segments
    .map((s) => (s.toLowerCase() === "repair and diagnosis (single page)" ? "Repair and Diagnosis" : s))
    .join("/");
}

// A "DTC ..." token: a single code ("DTC P0420"), a GM-style numeric range
// ("DTC P0300-P0306", high side reuses the low side's letter when omitted),
// or the "DTC P0010 To DTC P0341" section-header spelling of the same thing.
const DTC_TOKEN_RE_SRC =
  "\\bDTC\\s+([PBCU])([0-9A-Za-z]{3,4})(?:\\s*(?:-|to)\\s*(?:DTC\\s+)?([PBCU])?([0-9A-Za-z]{3,4}))?(?![0-9A-Za-z])";

function parseTargetDtc(dtc: string): { letter: string; num: number } | null {
  const m = /^([PBCU])([0-9A-Za-z]{3,4})$/i.exec(dtc.trim());
  if (!m) return null;
  // Codes' numeric part is technically hex (SAE J2012); parsing as base-16
  // keeps ordering correct either way and lets exact-match equality work for
  // plain-decimal-looking codes too.
  return { letter: m[1].toUpperCase(), num: parseInt(m[2], 16) };
}

// Whether `segment` names or ranges over `target`. When `anchored` is true
// the "DTC ..." token must start the (trimmed) segment -- the strong signal
// used for an actual DTC folder/link name. When false, the token may appear
// anywhere in the segment -- the weaker signal used for a broader section
// header that just says the code lives somewhere underneath.
function segmentMatchesDtc(
  segment: string,
  target: { letter: string; num: number },
  anchored: boolean
): boolean {
  const s = segment.trim();
  const re = new RegExp(DTC_TOKEN_RE_SRC, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (anchored && m.index !== 0) continue;
    const loLetter = m[1].toUpperCase();
    const hiLetter = (m[3] || loLetter).toUpperCase();
    if (loLetter !== target.letter || hiLetter !== target.letter) continue;
    const loNum = parseInt(m[2], 16);
    const hiNum = m[4] !== undefined ? parseInt(m[4], 16) : loNum;
    const from = Math.min(loNum, hiNum);
    const to = Math.max(loNum, hiNum);
    if (target.num >= from && target.num <= to) return true;
  }
  return false;
}

// Given every Single Page link found under a matched "DTC ..." folder,
// choose the one that best represents the pinpoint test: its "Diagnostic
// Instructions" child if present (GM-style folder with separate procedure
// pages nested underneath, #43), else the folder's own link if the matched
// segment is that link's last segment (Honda-style, #35), else just the
// first candidate found.
function pickFolderLink<T extends { segments: string[]; url: string }>(
  folderSegs: string[],
  candidates: T[]
): T {
  const instructions = candidates.find(
    (c) =>
      c.segments.length === folderSegs.length + 1 &&
      /^diagnostic instructions$/i.test((c.segments[folderSegs.length] ?? "").trim())
  );
  if (instructions) return instructions;

  const folderItself = candidates.find((c) => c.segments.length === folderSegs.length);
  if (folderItself) return folderItself;

  return candidates[0];
}

// Some manufacturers (Honda) never list a code in any DTC Index table at
// all -- it only shows up as a pinpoint-test folder name under the "Repair
// and Diagnosis (Single Page)" listing, split one folder per engine/system
// variant (e.g. "DTC P0420: ... (K24Z7)" vs. "... (Except K24Z7)"). Others
// (GM) group several codes under one range folder nested mid-path, not as
// the link's last segment at all (e.g. ".../DTC P0300-P0306: Engine Misfire
// Cylinders 1-6/Diagnostic Instructions/", #43). Match any segment naming or
// ranging over the code, collapse every link sharing that matched folder
// down to a single best pinpoint link (see pickFolderLink), and return every
// distinct matching folder rather than just the first, since a single code
// can legitimately have several variant-specific pinpoint tests.
export function findDtcLinksOnSinglePage(
  links: { segments: string[]; url: string }[],
  targetDtc: string
): SinglePageDtcMatch[] {
  const target = parseTargetDtc(targetDtc);
  if (!target) return [];

  // Prefer folders/links whose own name matches (anchored); only fall back
  // to a broader "DTC X To DTC Y" section header elsewhere in the path
  // (unanchored) when nothing anchored matched anywhere.
  for (const anchored of [true, false]) {
    const folders = new Map<
      string,
      { label: string; folderSegs: string[]; candidates: { segments: string[]; url: string }[] }
    >();

    for (const link of links) {
      const matchIdx = link.segments.findIndex((seg) => segmentMatchesDtc(seg, target, anchored));
      if (matchIdx === -1) continue;
      const folderSegs = link.segments.slice(0, matchIdx + 1);
      const key = folderSegs.join("/");
      const entry = folders.get(key) ?? { label: link.segments[matchIdx], folderSegs, candidates: [] };
      entry.candidates.push(link);
      folders.set(key, entry);
    }

    if (folders.size === 0) continue;

    return [...folders.values()].map(({ label, folderSegs, candidates }) => {
      const chosen = pickFolderLink(folderSegs, candidates);
      return { label, url: chosen.url, path: normalizeSinglePagePath(chosen.segments) };
    });
  }

  return [];
}

export interface DtcIndexResult {
  dtc: string;
  description: string;
  system: string;
  module: string;
  pinpoint_test_label: string;
  pinpoint_test_url: string;
  pinpoint_test_path: string;
  dtc_index_path: string;
  pinpoint_tests?: SinglePageDtcMatch[];
  note?: string;
}

// Some DTC Index table rows (Honda) name the code and its description but
// leave the pinpoint-test cell empty or link-less -- the real pinpoint test
// links only exist as per-variant folders on the "Repair and Diagnosis
// (Single Page)" listing (see findDtcLinksOnSinglePage above). When that's
// the case, merge those links into the index-table hit instead of returning
// it with an empty pinpoint_test_url: fill pinpoint_test_url/_path from the
// first match, and attach every match as pinpoint_tests[] so callers still
// see every engine/system variant (#41).
export function mergeSinglePageMatches(
  found: DtcIndexResult,
  matches: SinglePageDtcMatch[]
): DtcIndexResult {
  if (matches.length === 0) return found;
  const [first] = matches;
  return {
    ...found,
    pinpoint_test_label: found.pinpoint_test_label || first.label,
    pinpoint_test_url: first.url,
    pinpoint_test_path: first.path,
    pinpoint_tests: matches,
    note: `Index table row for ${found.dtc} had no pinpoint test link; merged in ${matches.length} matching link(s) from the "Repair and Diagnosis (Single Page)" listing -- some manufacturers split one code across multiple engine/system variants; check each label to find the one that applies.`,
  };
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
