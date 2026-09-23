// Pure, network-free helpers for parsing LEMON Manuals directory pages and
// turning their anchors into a navigable entry list. Split out from index.ts
// so this logic (and its edge cases around non-anchored category headers)
// can be unit tested without hitting the network.

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function pathSegments(path: string): string[] {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

export function encodePath(path: string): string {
  return pathSegments(path)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export interface LinkEntry {
  text: string;
  url: string;
  pathname: string;
  segments: string[];
}

// Non-content pages to skip when extracting links.
export const SKIP_PATHS = new Set([
  "",
  "nfo.html",
  "about.html",
  "bittorrent.html",
  "index.html",
  "lemon-manuals.torrent",
]);

export function extractLinks(html: string, baseUrl: string, allowedOrigins: string[]): LinkEntry[] {
  const re = /<a\s+[^>]*?href=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const out: LinkEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    const text = decodeEntities(m[4].replace(/<[^>]+>/g, "").trim());
    if (!text || rawHref.startsWith("javascript:") || rawHref.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (!allowedOrigins.includes(u.origin)) continue;
    const pathname = u.pathname.replace(/\/+$/, "");
    const tail = pathname.replace(/^\/+/, "");
    if (SKIP_PATHS.has(tail.toLowerCase())) continue;
    const key = pathname; // dedupe across mirrors by path
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      url: u.toString(),
      pathname,
      segments: pathSegments(pathname),
    });
  }
  return out;
}

export interface BrowseEntry {
  name: string;
  url?: string;
  path: string;
  type: "directory";
  // True when this entry has no page/anchor of its own — it's a plain-text
  // category header on the parent page, and its content lives one or more
  // levels deeper. See #22: some LEMON templates nest real content two-plus
  // path segments under such headers, e.g. "Electrical" > "Wiring Diagrams"
  // > the actual linked leaf pages.
  synthetic?: true;
}

// Builds the "directory" entries for a browse_manuals path from every link
// found on its (possibly ancestor-fallback) page. Anchors exactly one
// segment deeper than parentSegs become real entries. When a link is two or
// more segments deeper — meaning the intermediate segment(s) are plain-text
// headers with no anchor of their own — synthesize one entry per distinct
// intermediate segment so callers can still page through the tree one level
// at a time (#22).
export function computeBrowseEntries(parentSegs: string[], links: LinkEntry[]): BrowseEntry[] {
  const prefixMatches = (l: LinkEntry) =>
    parentSegs.every((seg, i) => l.segments[i]?.toLowerCase() === seg.toLowerCase());
  const isDownload = (l: LinkEntry) => /\.zip$/i.test(l.pathname) || /^\/bundle\//i.test(l.pathname);
  const descendants = links.filter(
    (l) => l.segments.length > parentSegs.length && prefixMatches(l) && !isDownload(l)
  );

  const entries: BrowseEntry[] = [];
  const directNames = new Set<string>();
  for (const l of descendants) {
    if (l.segments.length === parentSegs.length + 1) {
      const name = l.segments[parentSegs.length];
      entries.push({ name, url: l.url, path: l.segments.join("/"), type: "directory" });
      directNames.add(name.toLowerCase());
    }
  }

  const syntheticSeen = new Set<string>();
  for (const l of descendants) {
    if (l.segments.length <= parentSegs.length + 1) continue;
    const seg = l.segments[parentSegs.length];
    const key = seg.toLowerCase();
    if (directNames.has(key) || syntheticSeen.has(key)) continue;
    syntheticSeen.add(key);
    entries.push({ name: seg, path: [...parentSegs, seg].join("/"), type: "directory", synthetic: true });
  }

  return entries;
}
