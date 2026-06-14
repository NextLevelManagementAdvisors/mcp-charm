---
name: auto-tech-dx
description: "Step-by-step guided diagnostic for auto technicians — the pinpoint test execution skill. Use when a tech says run me through the pinpoint test for a DTC or system, walk me through diagnosis, what do I check next, I got a reading now what, or when auto-tech-intake hands off after identifying a pinpoint test. Presents one step at a time, waits for tech observation, branches based on result. Pulls wiring diagrams and component locations inline when referenced. Handles both code-based (pinpoint test) and symptom-based (differential) diagnostic modes. Never dumps the full procedure — always one action, one question, wait for response."
---

# Auto-Tech Diagnostic

Guided step-by-step diagnosis. One action. One question. Wait for the tech observation. Then branch.

**Core principle:** A tech in the bay, on their phone, with dirty hands, cannot process a 20-step procedure at once. Present exactly what they need for this moment and nothing more. The OEM pinpoint tests are already structured as decision trees — respect that structure.

## Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| Pinpoint | DTC + pinpoint test URL from intake | Follow OEM pinpoint test step by step |
| Symptom | No codes, symptom-based differential from intake | Build and execute differential diagnosis |
| Re-scan | After repair, code returned | Resume tree from confirmation step |

## Pre-Step: Load the Starting Point

If called from auto-tech-intake with a pinpoint test URL:
Vehicle manuals:get_manual_content(<pinpoint_test_path>)

Parse the page for: test steps (numbered), branch conditions (YES/NO), component references, required tools.

If the first step references a wiring diagram or component location by name, fetch it now and display inline before presenting step 1.

## The Step Loop

### Present One Step

Format every step the same way:

STEP [A1] — [Short title]

[Action in plain language — imperative, specific]
- [Any prerequisite: key on/off, engine running, connector unplugged, etc.]
- [Tool needed if non-obvious]
- [Measurement or observation to make]

[If wiring diagram/component location mentioned: fetch and display inline]

What did you find? [Expected ranges if applicable]

**Then stop. Wait for the tech response before proceeding.**

### Branch Based on Response

When tech reports their observation:
- Parse against the OEM branch conditions for that step
- Navigate to the correct next step from the manual
- If the manual branch condition does not clearly match the tech report: ask one clarifying question
- Never guess the branch — always confirm if ambiguous

If the next step is on a different page:
Vehicle manuals:get_manual_content(<next_page_path>)

### Inline Resources

When a step references external diagrams, fetch immediately:
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="<component> wiring diagram")
Vehicle manuals:search_manuals(make=<make>, year=<year>, keyword="<component> location")

Display inline at the moment needed, not ahead of time.

## Root Cause Identified

ROOT CAUSE CONFIRMED
Component: [e.g., Vacuum Control Motor — Rear HVAC]
Condition: [e.g., Motor failed — defaulted to heat position]
Evidence: [what the tech measurements showed]
Confirmed by: [pinpoint test step that terminated here]
-> Recommended repair: [component R&R or adjustment]
-> Proceed to: labor-estimator (for estimate) and/or auto-tech-repair (for procedure)

Ask: "Want the estimate, the repair procedure, or both?"

## Symptom Mode (No Codes)

Start with the highest-likelihood, lowest-cost item first. After each result, update differential confidence scores — rules out hypothesis means move to next candidate, confirms hypothesis means confirm root cause.

## Handling Common Patterns

- I already checked that: Accept the result, skip to the appropriate branch
- Not sure / hard to tell: Ask the one clarifying question that narrows it
- Tech wants to skip ahead: Explain briefly why the skipped step matters, then honor if they insist
- Component not accessible yet: Note it, add to pre-repair checklist, continue with accessible checks

## Session State

Maintain a running diagnostic log: vehicle info, DTCs, TSBs checked, steps performed, root cause, evidence.
