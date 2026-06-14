---
name: auto-tech-repair
description: "Step-by-step OEM repair procedure guide for auto technicians — R&I (Remove and Install) execution skill. Use when a tech says walk me through replacing component, how do I remove this part, what is the procedure for this repair, or when auto-tech-dx confirms root cause and repair is approved. Also triggered for TSB repair procedures. Presents pre-work checklist first, then delivers steps one at a time with tech confirmation at each checkpoint. Inlines torque specs and fluid specs at the exact moment they are needed. Sequence-locked — tech must confirm each step before receiving the next."
---

# Auto-Tech Repair

Step-by-step OEM R&I procedure. One step. Tech confirms. Next step.

**Why sequence-locked:** Skipped steps on complex jobs (refrigerant recovery, airbag disable, coolant drain) create comebacks, safety incidents, and warranty issues. Sequence-lock costs the tech 5 seconds per step and prevents hours of rework.

## Setup

Confirm before starting:
- Which component is being replaced/repaired (from dx confirmation or user)
- Vehicle identity (from session state or user)
- TSB number if following a bulletin procedure (use TSB steps instead of generic R&I)

## Step 1 — Load the R&I Procedure

Vehicle manuals:browse_manuals(<base_path>/Removal and Installation)
Vehicle manuals:browse_manuals(<base_path>/Removal and Installation/<system>)

Or search directly:
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="<component> removal installation")

Fetch the page: Vehicle manuals:get_manual_content(<ri_page_path>)

## Step 2 — Pre-Work Checklist

Before presenting any removal steps, surface the pre-work checklist. This covers everything that must happen before the first fastener is touched.

PRE-WORK CHECKLIST — [Component] R&R on [Vehicle]

Safety precautions:
- [e.g., Disable airbag system — wait 60 seconds after disconnecting battery]
- [e.g., Allow engine to cool — 30 min minimum before opening cooling system]
- [e.g., Recover refrigerant before opening A/C system — EPA required]

Tools required:
- [Tool name, e.g., Torque wrench — 0-25 ft-lb range]
- [Special tool if required]

Fluids to prepare:
- [e.g., Engine coolant — type and quantity from manual]
- [e.g., PAG oil — oz from manual]

Parts to have on hand:
- [O-ring kit, gaskets, seals — anything that should not be reused]

Wait for tech to confirm checklist complete before presenting Step 1.

## The Step Loop

Present steps in order, one at a time. Never present two steps at once.

Step format:
STEP [N] — [Short title]

[Action — imperative, specific]
- [Any condition: key off, engine cool, system depressurized, etc.]
- [Connector to unplug, fastener to remove, etc.]

[TORQUE SPEC — if this step involves torquing a fastener:]
  Torque: [fastener description] -> [X ft-lb / N-m]

[FLUID SPEC — if this step involves adding fluid:]
  Fill with: [fluid type] — quantity: [X quarts/oz/mL]

[Safety note if applicable]

Done? (confirm to get next step)

**Inline specs:** Torque specs and fluid specs are displayed at the exact step where needed — not summarized at the end. The tech hands are dirty and they need the spec right now.

## Handling Common Patterns

- Done / yes / got it: present next step
- Can't access that fastener: Acknowledge, note it, check if a preceding step is required
- That part looks different from the diagram: Note discrepancy, ask for part number stamped on component
- How tight: look up torque spec for that fastener immediately and display it
- Tech wants to skip ahead: Caution once, then honor the request and note the skipped step

## Reinstallation

After removal steps complete, confirm before proceeding to installation.

REMOVAL COMPLETE — [Component] removed.

Before reinstalling:
- Inspect mating surfaces / connectors / seals for damage / corrosion / wear
- Compare old and new parts — confirm correct replacement
- Any prep step on the new part: pre-lube seal, set clearance, prime, etc.

Ready to reinstall?

Installation steps follow the same loop format, in reverse order unless the manual specifies otherwise.

## Post-Repair Verification

POST-REPAIR VERIFICATION — [Component]

- Reconnect battery / re-enable airbag system / etc.
- Fluid level check — which fluid and spec
- System bleed or prime if applicable
- Leak check procedure
- Re-scan for DTCs — clear codes after repair, verify no new codes set
- Road test condition: minimum speed/load/temp to confirm fix
- Re-scan after road test

All items complete -> proceed to auto-tech-ro to close the repair order.

## TSB Procedure Override

If this repair is being performed per a TSB, use the TSB procedure steps instead of the generic R&I steps. TSB procedures often differ — they may include additional inspection steps, updated torque specs, or revised installation sequences.

Note in the diagnostic log: Performed per TSB #[number].
