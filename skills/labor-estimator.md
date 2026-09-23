---
name: labor-estimator
description: "Auto shop labor time lookup and repair estimate builder. Use when asked what is the labor time for a job, build me an estimate, how long does a repair take, what should I charge, or when auto-tech-intake or auto-tech-dx hands off after root cause is confirmed. Navigates the OEM labor times section of the correct vehicle manual, extracts operation times (diagnosis, R&R, testing, flush, overhaul), stacks related operations, flags overlap credits, and produces a formatted estimate block ready for the service writer."
---

# Labor Estimator

Build OEM-sourced labor estimates. Always pull times from the manual — never guess or use memory.

**Why this matters:** Labor guides from ALLDATA, Mitchell, or printed books cost shops $2,000+/year. The OEM manual labor times section is the same source, and it's available via the Vehicle Manuals MCP.

## Inputs Required

| Field | Source |
|-------|--------|
| Make + Year + Model | From intake session or user |
| Confirmed repair(s) | From dx session or user |
| Labor rate (dollar/hr) | From session config or user |

## Step 1 — Navigate to Labor Times

Vehicle manuals:browse_manuals(<base_path>/Labor Times)

Browse the directory tree to find the relevant system section (e.g., HVAC, Engine, Brakes).

Vehicle manuals:browse_manuals(<base_path>/Labor Times/<system>)

Navigate to the specific component (e.g., Auxiliary A/C and Heater Assembly).

Shortcut when path is unknown:
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="<component> labor")

## Step 2 — Extract Labor Operations

Fetch the labor page: Vehicle manuals:get_manual_content(<labor_page_path>)

The page will list operations with times. Extract:

| Operation | OEM Code | Time (hr) |
|-----------|----------|-----------|
| Diagnosis | D or similar | X.X |
| Remove and Replace (R&R) | R or similar | X.X |
| Testing | T or similar | X.X |
| Overhaul | OH or similar | X.X |
| Flush | F or similar | X.X |
| Bleed | B or similar | X.X |

If a sub-component is listed as "included" in a parent operation: note it and set its line to 0.0 (included).

## Step 3 — Stack and Credit

When multiple repairs are needed:
- Stacking: Add times for independent operations.
- Overlap credits: If two jobs share common disassembly steps, check whether one operation includes the access labor for the other. Look for "included" or "with" language.
- Flag overlap explicitly in the estimate so the service writer understands the credit.

## Step 4 — Build the Estimate

Format:

REPAIR ESTIMATE
Vehicle: [YEAR] [MAKE] [MODEL] [ENGINE]
VIN: [VIN]
Date: [today]

DIAGNOSIS
  [System] Diagnosis          [X.X hr]   0

REPAIR
  [Component] — R&R           [X.X hr]   0
  [Sub-component] (included)  [0.0 hr]   included
  Refrigerant — Recover       [X.X hr]   0
  Refrigerant — Evac/Charge   [X.X hr]   0

PARTS (estimate)
  [Part name] x [qty]                    0
  O-ring seal kit                        0

OVERLAP CREDIT
  [Description of shared access credit] -0

SUBTOTAL LABOR   [X.X hr]  0
SUBTOTAL PARTS             0
ESTIMATED TOTAL            0

Note: Parts pricing not yet confirmed. Estimate based on OEM labor times.

## Handoff

After presenting estimate:
- "Want me to walk the tech through the repair procedure? -> auto-tech-repair"
- "Ready to build the repair order? -> auto-tech-ro"
