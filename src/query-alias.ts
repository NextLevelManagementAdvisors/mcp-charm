// Pure helper backing search_manuals' backward-compatible "query" alias
// (see #36). PR #9 split "query" into "keyword" + "year"; clients holding
// an old cached tool schema (e.g. claude.ai connectors, until reconnect)
// keep sending "query". zod silently strips unknown keys, so those calls
// were landing with keyword=undefined and searching everything. Kept here
// so the parsing can be unit tested (see test/query-alias.test.mjs).

export interface ResolvedLegacyQuery {
  keyword: string | undefined;
  year: string | undefined;
}

const YEAR_RE = /\b(19|20)\d{2}\b/;

// Pull a 4-digit year out of a legacy "query" string and use the remainder
// as the keyword, e.g. "2015 Civic" -> { year: "2015", keyword: "Civic" }.
export function resolveLegacyQuery(query: string): ResolvedLegacyQuery {
  const match = query.match(YEAR_RE);
  const year = match ? match[0] : undefined;
  const rest = year ? query.replace(year, " ") : query;
  const keyword = rest.trim().replace(/\s+/g, " ") || undefined;
  return { keyword, year };
}
