---
name: tsb-checker
description: "TSB and recall checker for any vehicle — run before diagnosis to catch known OEM fixes. Use when asked any TSBs for this vehicle, check for recalls, known issues with complaint, is there a bulletin for this, or before any diagnostic session begins. Also triggered automatically by auto-tech-intake. Searches the OEM service manual for Technical Service Bulletins, Safety Recalls, and Campaigns matching the vehicle and complaint. Returns ranked hits with procedure summaries and flags free-repair recalls."
---

# TSB Checker

Check for known OEM fixes before any diagnosis. A TSB or Recall match means the vehicle manufacturer has already documented and solved the problem — running a full diagnostic is wasted labor.

## Inputs Required

| Field | Source |
|-------|--------|
| Make | VIN decode or user |
| Year | VIN decode or user |
| Model | VIN decode or user |
| Complaint keywords | From customer complaint |

## Step 1 — Search TSBs

Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="TSB")
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Technical Service Bulletin")

For each result, fetch content: Vehicle manuals:get_manual_content(<path>)
Scan for keywords matching the complaint (component names, conditions, symptoms).

## Step 2 — Search Safety Recalls

Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Safety Recall")
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Recall")

Safety Recalls are highest priority — they represent free OEM repairs. Fetch and scan each.

## Step 3 — Search Campaigns

Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Campaign")
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Customer Satisfaction")

Campaigns are non-safety field fixes. Often free or subsidized.

## Step 4 — Output

Always output results even if nothing matches. Suppress silence — nothing found is a useful conclusion.

When matches found:
- SAFETY RECALL [#] — [Title]: applies to, issue, OEM fix, cost FREE, advise dealer contact
- TSB [#] — [Title]: complaint match, known issue, OEM fix, supersedes, action -> auto-tech-repair
- CAMPAIGN [#] — [Title]: complaint match, fix available and whether subsidized

When no matches:
- No matching TSBs, Recalls, or Campaigns found for this complaint. Proceed with standard diagnosis.

## Priority Logic

1. Safety Recalls — always surface first regardless of complaint match strength
2. TSBs with exact component match — high confidence
3. TSBs with related system match — medium confidence
4. Campaigns — surface but lower priority than active repair TSBs

## Handoff

- Recall matches complaint: Report recall, advise dealer contact, stop. No estimate or diagnosis needed.
- TSB matches complaint: Surface TSB, then proceed to auto-tech-repair with TSB procedure (skip pinpoint test).
- Nothing found: Report no TSB/Recall match and hand off to auto-tech-dx.
