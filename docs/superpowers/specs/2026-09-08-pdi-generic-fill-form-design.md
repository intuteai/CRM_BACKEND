# PDI Generic Fill-Out Form (Phase 3) — Design Spec

**Date:** 2026-09-08
**Status:** Approved for implementation

## Problem

Phase 2 (shipped) lets an admin author a new PDI PDF template through a web UI and publish it — but nobody can actually *use* it. Creating a report against an authored template only works via direct API calls; there is no fill-out form, because Phase 1 and Phase 2 both deliberately deferred "a generic, schema-driven form renderer" as a materially harder problem than the PDF-generation side. This phase closes that gap: publish a template through the existing authoring UI, and it should be immediately fillable and generate a PDF, with no developer writing a form component for it.

## Scope

**In scope:**
- One new backend endpoint so a non-admin user can fetch a published template's definition (needed to render the form — the existing definition-returning endpoint is admin-only).
- A generic React form component that renders a working fill-out form for *any* template definition, by walking its `pages → sections` the same way the PDF renderer already does, with one render function per section type.
- Routing so an authored template's id lands on this generic form.
- A shared image crop/compress/upload utility module, extracted once for the generic form to use (not retrofitted into the two existing hand-coded forms).

**Explicitly out of scope, by explicit decision:**
- General's and AutoNXT's hand-coded forms (`PDIGeneratorForm.jsx`, `AutoNXTGeneratorForm.jsx`) are untouched — they keep serving their own templates exactly as today. The generic form only ever handles a template id it doesn't recognize as one of those two.
- No changes to the PDF-generation side (`renderer.js`, `authoredTemplate.js`, `pdi_generator.js`) — this phase is entirely about the fill-out side; report creation/save/finalize/download already work for any `template_id` since Phase 2.
- No new validation beyond what the backend already hard-requires (`pdi_no`). The generic form doesn't invent per-template-author "this field is required" rules the dialect has no way to express yet.

## The `pdi_no` gap

`PDIGenerator.generate`/`previewFromDefinition` hard-require `data.pdi_no` — enforced deep in the PDF generator itself, entirely independent of whatever fields a template's author happened to define. Phase 2's authoring UI never surfaced this, so an authored template can easily have no field mapped to `pdi_no` at all, and every finalize attempt against it would fail. Rather than retroactively validating this at authoring time (touching already-shipped Phase 2 code), the generic form **always renders one fixed "PDI No." input**, independent of the template's own header fields, always sent as `data.pdi_no`. This guarantees every already-published template works immediately, with zero changes to Phase 2. (If a template author's own header also happens to define a field mapped to `pdi_no`, both inputs would coexist, writing to the same key — an accepted, harmless, and unlikely edge case, not worth engineering around.)

## New backend endpoint

`GET /api/pdi/templates/:id/definition` — `authenticateToken` only (no admin gate, unlike the Phase 2 admin API), returns `{id, name, version, definition}` for the *active* version only (404 otherwise — matching the same restriction already enforced by the public picker and report creation, so a user can never open a form for a template that isn't actually offered). Backed by the existing `AuthoredTemplates.getActive(id)` — no new data-access method needed.

## Routing

`routeConfig.jsx` gains one new route, `/pdi-generator/:templateId`, registered alongside (not replacing) the existing literal `/pdi-generator/general` and `/pdi-generator/autonxt` entries. React Router ranks static path segments above dynamic ones regardless of array order, so those two keep resolving to their own hand-coded components untouched; only an id the router doesn't have a literal route for falls through to the new generic route. `PdiTemplatePicker.jsx` and `PdiReportsTable.jsx`'s Resume action need no changes — both already navigate to `/pdi-generator/<id>`, which now simply resolves either way depending on the id.

## The generic form component

`GenericPdiGeneratorForm.jsx` (new): on mount, reads `:templateId` from the route, fetches `GET /api/pdi/templates/:templateId/definition`. Renders one tab per `definition.pages` entry (mirroring how the two hand-coded forms already split fields across tabs roughly along page boundaries), each tab rendering its page's sections in order via one function per section type:

- **header** → each `infoFields` entry becomes a pair of labeled inputs (text or date, per `leftFormat`/`rightFormat`), writing to `data[leftKey]`/`data[rightKey]`.
- **table, `mode: 'repeatable'`** → an add/remove-rows table; every column renders as an editable input (repeatable columns are expected to all be `{source:'row'}` in practice — the dialect technically allows other sources here, but they have no sensible per-row meaning without a fixed row `key`, so the form treats any non-`row` column in a repeatable table as read-only rather than erroring). One entry per row in `data[dataKey]`; a row left blank on the `filterKey` field is simply skipped by the PDF renderer at generation time, matching today's behavior — no separate "remove" affordance is required for that case, though the standard remove button still exists.
- **table, `mode: 'fixed'`** → a checklist table, one row per template-defined `fixedRows` entry. `row`/`constant`-sourced columns render as **read-only** text; only `sectionData`-sourced columns render as an editable input (a bounded set of common option values — GO/NG/NA — via a select when the column's `default` looks like one of those, otherwise a plain text input), writing to `data[dataKey][row.key][subfield]`.
- **photo, `mode: 'freeform'`** → add/remove photo slots (label input + image upload), `data[dataKey]` = array of `{label, image}`.
- **photo, `mode: 'fixed-slots'`** → one fixed upload slot per defined slot (label read-only), `data[dataKey]` = object keyed by slot key.
- **image** → a single image upload, `data[dataKey]` = one data-URI, using the section's `title`/`placeholder` (if present) purely as on-screen labeling — the form never needs to render the placeholder's fallback text/annotations itself, that's a PDF-only concern.
- **signature** → one text input per role, `data[role.key]`.
- **text** → one textarea, `data[dataKey]`, pre-filled with the section's `default`.

Save/resume/cancel/finalize mirrors the existing forms exactly: `handleOpen` POSTs `{template_id: templateId}` to create a draft; `handleSave` PATCHes `{data, photos, status: 'In Progress'}`; `handleClose` DELETEs an unsaved draft; `handleFinalize` PATCHes then POSTs `/finalize` and downloads the resulting PDF blob; resume via `?report=<id>` GETs the report and merges its `data`/`photos` into the form's default shape built from the template definition. `inspected_by` is computed by joining every non-empty `signature` role value (in the order the template defines its roles) with `' / '`, falling back to `undefined` (not an empty string) when none are filled — the same pattern AutoNXT's own hand-coded form already uses for its two preparer roles, generalized to however many roles a given template defines.

## Shared image utilities

`src/utils/pdiImageUpload.jsx` (new): `ImageUploadCard`, `CropModal`, `fileToDataUri`, `cropAndCompress` extracted verbatim from `PDIGeneratorForm.jsx` (byte-identical logic, just relocated) for the generic form to import. `PDIGeneratorForm.jsx` and `AutoNXTGeneratorForm.jsx` are **not** touched or refactored to use this shared module — they keep their own copies exactly as Phase 1 left them, per this phase's explicit no-touch scope for those two files. The duplication that already exists between those two stays; this phase just doesn't add a *third* copy.

## Testing

**Backend:** a test for the new `GET /api/pdi/templates/:id/definition` endpoint — returns the active version's definition for a published template, 404 for a draft/archived/nonexistent one, works for a non-admin token (proving the no-admin-gate requirement).

**Frontend:** no test framework exists for this codebase's React components, consistent with every prior PDI form (`PDIGeneratorForm.jsx`, `AutoNXTGeneratorForm.jsx`, `PdiTemplatePicker.jsx`, `PdiTemplatesAdminPage.jsx` were all verified via lint, build, and a live browser walkthrough only). This phase follows the same pattern: lint + build clean, plus a live end-to-end walkthrough — author and publish a template covering all 6 section types, open it from the picker, fill it out, save, resume, finalize, confirm the generated PDF matches what was entered — before shipping.
