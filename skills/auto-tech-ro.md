---
name: auto-tech-ro
description: "Repair Order (RO) builder for auto shops — generates a formatted RO document from the session diagnostic and repair data and saves it to Google Drive. Use when asked build me the RO, write up the repair order, close out this job, generate the invoice, or when both diagnosis and estimate are complete and the customer has approved. Pulls vehicle info, DTC list, root cause narrative, labor lines, and parts list from the session, produces a print-ready RO document, and saves to Drive."
---

# Auto-Tech Repair Order Builder

Generate the RO after diagnosis and customer approval. This closes the diagnostic and repair loop into a billable document.

## Inputs (collected from session or prompted)

| Field | Source |
|-------|--------|
| Vehicle info | auto-tech-intake session state |
| Customer name / contact | Ask if not in session |
| Mileage in / mileage out | Ask |
| Customer complaint (verbatim) | auto-tech-intake session state |
| DTC list | auto-tech-dx session state |
| Root cause findings | auto-tech-dx session state |
| Recommended repair | auto-tech-dx -> auto-tech-repair |
| Labor lines + times | labor-estimator session state |
| Parts list + prices | labor-estimator session state or user input |
| Tech name | Session config or ask |
| Repair date | Today |
| Authorization status | Customer verbally approved / Signed estimate / Written auth on file |

## RO Document Structure

REPAIR ORDER
Shop: [Shop Name]
Address: [Shop Address if configured]
Phone: [Shop Phone if configured]
Date: [YYYY-MM-DD]
RO #: [Auto-generate: YYYYMMDD-NNN or ask for shop numbering]

CUSTOMER
Name: [Customer Name]
Phone: [Customer Phone]
Email: [Customer Email]
Authorization: [Verbal / Written / Signed estimate on file]

VEHICLE
Year: [YEAR]
Make: [MAKE]
Model: [MODEL]
Engine: [ENGINE]
VIN: [VIN]
Mileage In: [MILEAGE]
Mileage Out: [MILEAGE — fill after repair]

CUSTOMER COMPLAINT
[Verbatim complaint from customer]

TECHNICIAN FINDINGS
Codes found:    [DTC list or None]
TSBs checked:   [Number checked, match status]

Diagnosis:
  [Narrative — what was found, what tests were run, what the root cause is]
  [Reference: Pinpoint Test [X], Step [N] confirmed root cause]
  [Or: Performed per TSB #[number]]

Root cause: [Component — condition]

RECOMMENDED REPAIR
[What is being replaced/repaired and why]
[Manual reference if applicable]

LABOR
[Operation]                   [hr]    [amount]
[Operation]                   [hr]    [amount]
[Sub-operation (included)]    0.0     included
TOTAL LABOR                  [hr]   0

PARTS
[Part description]   [part#]   [qty]   [price]
TOTAL PARTS                            0

TOTALS
Labor:           0
Parts:           0
Tax ([rate]%):   0
TOTAL DUE:       0

TECHNICIAN
Tech:       [Tech Name]
Date in:    [DATE]
Date out:   [DATE]

## Save to Google Drive

After generating the RO text:

1. Format as a Google Doc or plain text file
2. Save via your connected Google Workspace / Docs MCP (the create_doc tool):
create_doc(
  title="RO [date] — [YEAR] [MAKE] [MODEL] — [Customer Last Name]",
  content=<ro_text>
)
Or create in the shop designated RO folder if configured.

3. Return the Drive link to the user.

## Post-Save

After saving:
RO saved to Google Drive
Link: [Drive URL]

Next steps for service writer:
- Print or email to customer for signature (if not already signed)
- Record payment when collected
- File in vehicle history

Ask: "Want me to draft a customer email with the RO attached?"
