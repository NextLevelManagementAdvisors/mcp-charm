// Pure, network-free parser for LEMON Manuals Labor Times leaf pages. Split
// out from index.ts so it can be unit tested without hitting the network,
// mirroring the browse-links.ts split.
import { decodeEntities } from "./browse-links.js";

export interface LaborTimeRow {
  component: string;
  operation: string;
  applies_to: string;
  time_hours: number | null;
  warranty_hours: number | null;
  skill_level: string;
  notes: string;
}

export const isDecimal = (s: string): boolean => /^\d+(\.\d+)?$/.test(s);

export function stripLaborCell(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, "; ").replace(/<[^>]+>/g, "")).trim();
}

// Labor Times leaf pages hold a title ("Component: Operation"), an optional
// intro, and a table of hour rows. Rows can be interrupted by full-width
// "Combination Procedure" separators that introduce a related component/
// operation bundled onto the same page (e.g. a brake-hose bleed procedure
// listed on the brake-pad R&R page) — track the active label as we walk rows.
export function parseLaborLeaf(html: string): LaborTimeRow[] {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match ? decodeEntities(h1Match[1].replace(/<[^>]+>/g, "")).trim() : "";
  const sepIdx = h1Text.indexOf(": ");
  const pageComponent = sepIdx >= 0 ? h1Text.slice(0, sepIdx).trim() : h1Text;
  const pageOperation = sepIdx >= 0 ? h1Text.slice(sepIdx + 2).trim() : "";

  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const tbodyMatch = tableMatch[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const trs = (tbodyMatch ? tbodyMatch[1] : "").match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];

  const rows: LaborTimeRow[] = [];
  let curComponent = pageComponent;
  let curOperation = pageOperation;
  let curGroupNote = "";

  for (const tr of trs) {
    const comboMatch = tr.match(/<td[^>]*\bcolspan=[^>]*>([\s\S]*?)<\/td>/i);
    if (comboMatch) {
      const cellHtml = comboMatch[1];
      const labelMatch = cellHtml.match(/Combination Procedure:<\/b>\s*([^<]*)/i);
      const label = labelMatch ? decodeEntities(labelMatch[1]).trim().replace(/:$/, "") : "";
      curGroupNote = stripLaborCell(cellHtml.split(/<br\s*\/?>/i).slice(1).join(" "));
      if (label) {
        const idx = label.indexOf(": ");
        if (idx >= 0) {
          curComponent = label.slice(0, idx).trim();
          curOperation = label.slice(idx + 2).trim();
        } else {
          curOperation = label;
        }
      }
      continue;
    }
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripLaborCell(m[1]));
    if (cells.length < 5) continue;
    const [appliesTo, note, stdHours, warHours, skill] = cells;
    const noteParts = [curGroupNote, note].filter(Boolean);
    if (stdHours && !isDecimal(stdHours)) noteParts.push(`standard hours: ${stdHours}`);
    rows.push({
      component: curComponent,
      operation: curOperation,
      applies_to: appliesTo,
      time_hours: isDecimal(stdHours) ? parseFloat(stdHours) : null,
      warranty_hours: isDecimal(warHours) ? parseFloat(warHours) : null,
      skill_level: skill,
      notes: noteParts.join("; "),
    });
  }
  return rows;
}
