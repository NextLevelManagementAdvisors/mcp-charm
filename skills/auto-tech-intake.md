---
name: auto-tech-intake
description: "Auto shop AI technician intake — the entry point for every repair order. Use immediately when a service writer or tech provides any of: a customer complaint, a VIN, scanner codes, or a symptom. Trigger phrases: customer says, we pulled codes, VIN is, customer complaint, check engine, no start, rough idle, blows hot, blows cold, pulls left, check codes on, what is wrong with, diagnose this, or any vehicle plus symptom combination. Decodes VIN via NHTSA, finds the exact OEM service manual, runs a TSB/recall check before any diagnosis, maps DTCs to pinpoint test pages, and routes symptom-only jobs to the correct diagnostic section. Always use this skill first — never skip to diagnosis without running intake."
---

# Auto-Tech Intake

Entry point for every repair order. Run this before any diagnosis, estimate, or repair.

**Why this exists:** Without a structured intake, a tech can spend 20 minutes manually navigating the OEM manual tree to find the right pinpoint test. This compresses that to under 2 minutes and ensures TSBs/Recalls are checked first — known fixes first, diagnosis second.

---

## Session Config (collect once, carry through)

| Field | Default | Example |
|-------|---------|---------|
| Shop name | (ask) | Shenandoah Valley Auto |
| Labor rate (dollar/hr) | (ask) | 120 |
| Tech name | optional | Mike |

---

## Step 1 — Identify the Vehicle

Collect at least one:
- **VIN** (preferred, 17 chars) — use VIN:decode_vin(vin=<vin>)
- **Year + Make + Model + Engine** — fallback if no VIN or decode fails

If VIN provided and decode fails (invalid VIN, non-US market), fall back and ask.

Confirm with user: "Got it — [YEAR] [MAKE] [MODEL] [ENGINE]. Is that right?"

From the VIN decode, record: model_year, make, model, engine_configuration, engine_displacement_l, drive_type.

---

## Step 2 — Capture the Complaint

Record all of:

| Field | Notes |
|-------|-------|
| Customer complaint (verbatim) | Exact words matter for TSB matching |
| DTCs from scanner | All codes, or no codes, or not scanned yet |
| Conditions | When does it happen? Speed, temp, load? |
| Prior repairs | Anything already replaced related to this complaint? |

If scanner has not been run: recommend scanning before diagnosis unless the failure mode is obvious (visible damage, won't crank, etc.).

---

## Step 3 — Find the Manual

Vehicle manuals:search_manuals(make=<make>, year=<year>)

Select the result matching model exactly. Record the base path (e.g., Ford/2011/E450).

If the exact year yields no results: try year plus or minus 1 (procedures are often shared across model years for running-change vehicles). Note which year's manual is being used.

---

## Step 4 — TSB and Recall Check (ALWAYS before diagnosis)

This step prevents reinventing fixes that the OEM already documented. Never skip it.

Run these searches against the manual:
- Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="TSB")
- Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Safety Recall")
- Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="Campaign")

For each hit, get_manual_content(<path>) and keyword-scan for terms from the customer complaint.

**If a TSB matches:**
- Report: TSB #[number] — [title]. Known fix: [brief summary].
- If the TSB has a repair procedure, go directly to auto-tech-repair with that procedure instead of diagnosing.

**If a Safety Recall matches:**
- Report: RECALL [number] covers [complaint]. This is a no-charge OEM repair.
- Advise customer to contact the dealer if not already repaired.

**If nothing matches:** Note "No matching TSB or Recall" and continue.

---

## Step 5 — Route by Complaint Type

### Route A: DTCs Provided

For each DTC code: Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword=<dtc_code>)

- If a pinpoint test page is returned: record the path and test label (e.g., Pinpoint Test A).
- If not found by code: try searching by the code plain-English description (e.g., P0128 maps to coolant temperature).
- For multiple codes: list all pinpoint URLs, then prioritize:
  1. Safety-critical systems (airbag, brake, steering) — always first
  2. Codes that cluster around a common system — likely root cause
  3. Secondary codes that often follow the primary — lower priority

After listing all codes with paths, proceed to auto-tech-dx for the highest-priority DTC.

### Route B: Symptom Only (No Codes)

Navigate to the diagnostic section: Vehicle manuals:browse_manuals(<base_path>/Repair and Diagnosis)

Also search by symptom keywords: Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword=<symptom_keyword>)

Try 2-3 keyword variants from the complaint (e.g., no rear AC, rear heat, auxiliary HVAC).

Build a differential — 2-4 candidate systems ordered by likelihood with a brief rationale.

---

## Step 6 — Intake Summary Output

Always end with this structured block:

INTAKE SUMMARY:
- Vehicle: [YEAR] [MAKE] [MODEL] [ENGINE]
- VIN: [VIN or not provided]
- Complaint: [verbatim customer statement]
- DTCs: [list or none or not scanned]
- TSB/Recall: [match found: description] OR [none found]

DIAGNOSTIC PLAN:
- Priority 1: [action] -> [pinpoint test label + path, OR section to navigate]
- Priority 2: [if P1 rules out -> next action]
- Priority 3: [further fallback]

NEXT STEP: [specific instruction]

After presenting, ask: "Ready to start? I will walk you through one step at a time."
- If yes -> proceed to auto-tech-dx
- If they want an estimate first -> proceed to labor-estimator
