# PDI Template Engine — Design Spec

**Date:** 2026-09-07
**Status:** Approved for implementation (Phase 1 only)

## Problem

The PDI system currently supports exactly one report format — "General" — hardcoded end to end: the fill-out form (`PDIGeneratorForm.jsx`), the PDF layout (`models/operations/pdi_generator.js`), and the section content are all written assuming General's specific structure (fixed checklist rows, free-form photo grid, 2-way sign-off, drawing on page 2).

Real customers use structurally different PDI formats. A concrete example — AutoNXT's motor PDI — differs from General in table *shape* (a per-motor-row table instead of a fixed checklist), photo behavior (pre-labeled fixed slots instead of free-form), page composition, an extra field (Controller Type), and sign-off structure. Supporting a second format by copy-pasting `pdi_generator.js` and hand-editing it would work once, but doesn't scale past 2-3 formats and duplicates the pagination/image/font logic that has nothing to do with General specifically.

## Scope of this spec (Phase 1)

This is the first of two planned sub-projects:

- **Phase 1 (this spec):** a template engine — a data format for describing a PDI report's structure — plus a generic PDF renderer that walks that structure. Validated by re-expressing **General** through it (must remain visually identical to today's output) and then adding **AutoNXT** as a second template using the same renderer.
- **Phase 2 (future, separate spec):** a structured template-authoring UI so new templates can be defined without writing code. Deliberately deferred — Phase 1 answers the open architectural risk (does the abstraction actually cover real-world formats?) cheaply, before investing in authoring UX on top of it.

**Explicitly out of scope for Phase 1:**
- The web fill-out form stays hand-coded per template (a new `AutoNXTGeneratorForm.jsx` alongside the existing `PDIGeneratorForm.jsx`), not schema-driven. A generic, schema-driven *form* renderer is a materially harder problem than a PDF renderer (interactive, stateful, per-field validation) and isn't needed to prove the template abstraction.
- No database table for templates. Both templates are defined as code/config shipped in the repo, the same way General's layout is hardcoded today. A templates DB table is Phase 2's concern — that's when templates start being created/edited at runtime instead of by a developer, which is what actually needs persistence.
- No changes to `pre_dispatch_inspection_reports`' schema. `template_id`, `data`, and `photos` columns already exist and already support this.

## The section vocabulary

Every section in both known formats reduces to one of five reusable types:

| Type | Purpose | Key variation |
|---|---|---|
| **header** | Company/format info + top-level fields (PDI No, Customer, Date, ...) | Field *list* is template-specific; layout is shared |
| **table** | Columns + rows | `mode: 'fixed'` — rows baked into the template (General's checklist); `mode: 'repeatable'` — rows supplied by fill-time data, one per item (AutoNXT's per-motor table) |
| **photo** | A grid of labeled photos | `mode: 'freeform'` — arbitrary user-added photos with typed labels (General today); `mode: 'fixed-slots'` — a template-defined list of required labeled slots (AutoNXT) |
| **image** | A single embedded image in a fixed spot | e.g. General's technical-drawing box |
| **signature** | A list of signer roles | Configurable role list — 2-way (Prepared/Approved) today, extendable to more roles if a format needs it |

A template is:

```js
{
  id: 'autonxt',
  name: 'AutoNXT Motor PDI',
  version: 1,
  pages: [
    { sections: [ /* header, table, ... */ ] },
    { sections: [ /* ... */ ] },
  ],
}
```

Each section object carries `type` plus type-specific config (columns, fixed rows, slot labels, field keys, etc). The exact per-section config shape is finalized during implementation of the first template (General), since that's where the real fields get enumerated.

## Renderer architecture

`models/operations/pdi_generator.js` currently hardcodes three pages of draw calls specific to General. This gets split into:

1. **Shared drawing primitives** (already mostly type-agnostic today: `box`, `t`, `drawImageInBox`, `decodeImageDataUri`, `registerFonts`, the `drawPaginatedRows` overflow/pagination logic, page numbering) — extracted into a shared module, unchanged in behavior.
2. **A generic template renderer** — `renderTemplate(doc, template, data)` — that walks `template.pages → sections` and dispatches each section to a type-specific drawer: `drawHeaderSection`, `drawTableSection`, `drawPhotoSection`, `drawImageSection`, `drawSignatureSection`. These drawers are written once and reused by every template.
3. **Template definitions** — `models/operations/pdi_templates/general.js` and `.../autonxt.js` — pure data, no drawing code.
4. **A registry** — `models/operations/pdi_templates/index.js` exporting `{ general: generalTemplate, autonxt: autonxtTemplate }`.

`PDIGenerator.generate` changes signature from `generate(data)` to `generate(templateId, data)`: looks up the template in the registry, calls `renderTemplate`. The two callers in `models/operations/pdiReports.js` (`finalizeReport`, `getPdfBuffer`) already have `report.template_id` on hand — this is a one-line change at each call site.

**Validation gate for General's re-expression:** since General is in production, re-expressing it as a template must not visibly change its PDF output. This is checked by generating a PDF from the same test fixture data before and after the refactor and comparing them page-by-page (visual/manual check, since PDFKit output isn't byte-stable across identical runs — timestamps, etc). General's re-expression is a prerequisite task before AutoNXT is added, so any abstraction gaps get caught on a format that's easy to verify against, not on the new one.

## Template selection and routing

- **Creation:** `POST /api/pdi/reports` already accepts a `template_id` field (defaults to `'general'`). No change needed — the frontend just starts passing a real value.
- **Discovery:** `GET /api/pdi/templates` already exists (currently a stub returning only General). It grows a second entry once AutoNXT's template definition exists — still hardcoded, matching Phase 1's "no DB" decision. The dashboard's "New PDI Report" flow calls this to populate a template picker.
- **New report flow:** the dashboard's existing single "New PDI Report" action gains an intermediate picker (populated from `GET /api/pdi/templates`) instead of jumping straight to `PDIGeneratorForm`. Picking a template navigates to that template's form component.
- **Form routing:** a `template_id → form component` map (e.g. `general` → `PDIGeneratorForm`, `autonxt` → `AutoNXTGeneratorForm`) lives in the frontend routing layer.
- **Resume:** the dashboard already has `report.template_id` in the list payload (via `listReports`). Resume navigation changes from the current fixed `/pdi-generator?report=<id>` to a template-aware route (e.g. `/pdi-generator/:templateId?report=<id>`) so it opens the correct form component for that report's template.

## Testing

- Existing `tests/pdiReports.test.js` coverage (create/list/patch/finalize/delete, the photos regression test) must keep passing unmodified against General — proving the refactor didn't change behavior for the format already in production.
- A new test generates a PDF from the AutoNXT template with representative fixture data and asserts it succeeds and produces a valid PDF (`%PDF-` header), mirroring the existing finalize test's shape.
- No visual/pixel-diff automation — PDF visual verification for this feature is done manually (render to PNG and inspect), consistent with how PDF changes have been verified elsewhere in this project.

## Open item carried into implementation

AutoNXT's exact field list, table columns, and photo-slot labels were read from a reference PDF pasted earlier in this working session; that document's content didn't survive into current context and isn't saved to disk. The AutoNXT template definition task in the implementation plan will need that document re-supplied before it can be written accurately — every other task (shared primitives extraction, generic renderer, General's re-expression, routing/picker work) is independent of it and can proceed first.
