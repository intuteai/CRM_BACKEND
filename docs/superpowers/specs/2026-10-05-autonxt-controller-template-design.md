# AutoNXT Controller PDI Template

## Context

A third PDI template, alongside `general` and `autonxt` (AutoNXT Motor). Covers Pre-Dispatch Inspection of the AutoNXT controller unit itself (distinct physical product from the motor), built from a real Compage QA reference document (`CASPL-QA-PDI-202509008`, PMSM Controller CASHV38140, a 20-unit lot). The reference document confirmed this is a genuinely different report shape from both existing templates — no RPM/BEMF/Current performance table at all; instead a firmware-parameter verification table plus a Go/NG general checklist — and that controllers ship in lots the same way motors do (this reference alone covers 20 serials).

Decided while scoping this:
- **Multiple controller types exist** (not just CASHV38140), each needing its own parameter list. Routing this through the existing admin-authored-template system was considered and ruled out: the mobile app has zero support for authored templates today (confirmed by search — only `general`/`autonxt` are hand-coded there), and this template must ship on web and mobile both. So this is a third hand-coded template, same as `autonxt`, with controller-type variation handled via **hard-coded presets** (same pattern as `autonxt`'s own `SPEC_DEFAULTS`) rather than self-serve authoring.
- Full feature parity with AutoNXT Motor is in scope from day one: lot/batch reports, controlled editing of finalized reports, revision-aware web form, mobile app support. This is not a reduced first cut.
- Only the `CASHV38140` preset ships now. Adding another controller type later is a small, fast addition to a presets object — not a redeploy-free admin workflow, but not a big lift either.

## Scope

**In scope:**
1. New template `autonxt_controller`, registered in `models/operations/pdi/templates/index.js`.
2. Section A (Parameter Check): a repeatable/editable table seeded from a controller-type preset, with auto-computed exact-match Remarks.
3. Section B (General Check): a fixed 10-row Go/NG checklist, matching the reference document exactly.
4. 5 fixed photo slots.
5. Lot/batch support — same `pdi_report_batches` mechanism already built for `autonxt`, just usable with `template_id: 'autonxt_controller'`.
6. Controlled editing of finalized reports — already template-agnostic (`patchReport`/`deleteReport`/revision tracking live in `pdiReports.js`, not per-template) — this template gets it automatically, no new backend work beyond registering the template.
7. Web: a new single-report generator form and a new batch creation/overview form, mirroring `AutoNXTGeneratorForm.jsx`/`AutoNXTBatchForm.jsx`.
8. Mobile: a handoff document to the app developer (API contract + field reference), same process as every other mobile feature this session. No `pdi-erp-app` code is written here.

**Explicitly out of scope:**
- Any controller type other than `CASHV38140` — no reference document exists for another type yet.
- Changes to the admin-authored-template system or adding authored-template support to mobile — a separate, much larger project, not needed for this.
- Any change to the `general` or `autonxt` (motor) templates.

## Data model

No schema changes. `pre_dispatch_inspection_reports.template_id = 'autonxt_controller'` is enough — `batch_id`, `lot_index`, `revision_no`, `data`, `photos` are all already template-agnostic columns, reused exactly as-is (same reasoning as the original AutoNXT batch spec: "the schema is template-agnostic... costs nothing to leave open").

`pdi_report_batches`'s existing 5 shared-override columns (`customer_name`, `product_id`, `product_specifications`, `drawing_no`, `controller_type`) are reused unchanged — `controller_type` already exists as a column (added for AutoNXT Motor's header field of the same name) and fits this template's own Controller Type field with zero schema change.

## Section A — Parameter Check

Rendered with `mode: 'repeatable'` (the same table mode General's checklist tables already use for a variable-length, technician-editable row list — see `general.js:152-153`), not `mode: 'fixed'` like AutoNXT Motor's tables. This is the key structural difference from `autonxt`: AutoNXT's tables are a template-fixed row count with only Measured values filled in; here the *row list itself* varies by controller type, so it has to live in `data` as real stored rows, not be recomputed from a template-side function every render.

```js
const CONTROLLER_TYPE_PRESETS = {
  CASHV38140: [
    { parameter: 'F01.00', specification: '11' },
    { parameter: 'F01.01', specification: '1' },
    { parameter: 'F01.02', specification: '2' },
    { parameter: 'F01.09', specification: '90' },
    { parameter: 'F01.10', specification: '90' },
    { parameter: 'F01.12', specification: '90' },
    { parameter: 'F01.22', specification: '5' },
    { parameter: 'F01.23', specification: '14' },
    { parameter: 'F02.00', specification: '1' },
    { parameter: 'F02.01', specification: '6' },
    { parameter: 'F02.02', specification: '32' },
    { parameter: 'F02.03', specification: '90' },
    { parameter: 'F02.04', specification: '1800' },
    { parameter: 'F02.05', specification: '270' },
    { parameter: 'F02.06', specification: '60' },
    { parameter: 'F02.07', specification: '1' },
    { parameter: 'F05.50', specification: '8.5' },
    { parameter: 'F05.52', specification: '50' },
    { parameter: 'F10.01', specification: '100' },
    { parameter: 'F10.43', specification: '0' },
    { parameter: 'F10.17', specification: '250' },
    { parameter: 'F10.21', specification: '10' },
    { parameter: 'F10.28', specification: '110' },
    { parameter: 'F10.30', specification: '200' },
    { parameter: 'F10.31', specification: '0001' },
    { parameter: 'F10.32', specification: '0001' },
    { parameter: 'F10.34', specification: '1.0' },
    { parameter: 'F10.35', specification: '100' },
    { parameter: 'F10.50', specification: '3' },
    { parameter: 'F10.57', specification: '1' },
    { parameter: 'F07.10', specification: '1' },
    { parameter: 'F07.12', specification: '0.000' },
    { parameter: 'F07.23', specification: '0.00' },
    { parameter: 'F03.15', specification: '100' },
    { parameter: 'F01.13', specification: '37.50' },
  ],
};
```

(Transcribed directly from the 35-row reference document, confirmed identical across both sample units in the lot.)

On report creation, when `controller_type` is set (or changes), `data.parameter_rows` is seeded from `CONTROLLER_TYPE_PRESETS[controller_type].map(r => ({ ...r, measured: '', remarks: '' }))` — same seed-then-edit relationship AutoNXT's `SPEC_DEFAULTS` already has with a report's own data, just materialized into stored rows instead of computed from constants on every render, since the row *list* (not just values) needs to persist and be independently editable.

**Remarks column**: auto-computed per row — `measured === specification` (trimmed string compare) → `OK`, otherwise `NG`. The field stays stored and editable: a technician can override it to `NA` (or any text) for a parameter that doesn't apply to a given unit, same as General/AutoNXT's `GO/NG/NA` convention elsewhere. An explicit non-empty override in `data.parameter_rows[i].remarks` wins over the computed value; computed `OK`/`NG` is only the default.

Columns: S.No (row position, 1-indexed, not stored), Parameter, Specification, Measured Value, Remarks.

## Section B — General Check

`mode: 'fixed'`, fixed 10-row checklist — transcribed directly from the reference document:

```js
const CONTROLLER_GENERAL_CHECK_ROWS = [
  { key: 'can_card',        sno: 1,  label: 'CAN CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'io_card',         sno: 2,  label: 'I/O CARD CHECK',            spec: 'Go/NG', method: 'VI' },
  { key: 'power_connector', sno: 3,  label: 'Power Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'pin14_connector', sno: 4,  label: '14PIN Connector check',     spec: 'Go/NG', method: 'VI' },
  { key: 'resolver_conn',   sno: 5,  label: 'Resolver connector',        spec: 'Go/NG', method: 'VI' },
  { key: 'rj45_connector',  sno: 6,  label: 'Rj45 connector check',      spec: 'Go/NG', method: 'VI' },
  { key: 'harness_check',   sno: 7,  label: 'HARNESS CHECK',             spec: 'Go/NG', method: 'VI' },
  { key: 'drive_on_key',    sno: 8,  label: 'DRIVE ON WHEN KEY S/W ON',  spec: 'Go/NG', method: 'TESTING' },
  { key: 'run_750_rpm',     sno: 9,  label: 'RUN @750 RPM WHEN START',   spec: 'Go/NG', method: 'TESTING' },
  { key: 'physical_check',  sno: 10, label: 'PHYSICAL CHECK',            spec: 'Go/NG', method: 'VI' },
];
```

Measurement column: free text, defaulting `'GO'`, same `(sectionData[row.key] || {}).measured || 'GO'` pattern as `autonxt.js:124`. Web/mobile UI offer `GO`/`NG`/`NA` as one-click suggestions (matching this session's decision to reuse AutoNXT Motor's existing convention, not invent a new one) — this is UI sugar only, the backend stores whatever string is sent, exactly like AutoNXT Motor's own General Check and Physical Parameters sections already do.

## Header & photos

Header `infoFields`, matching the reference document (replacing AutoNXT Motor's `Motor Sr.No` row with `Controller Sr.No`):

```js
infoFields: [
  ['Customer Name:', (d) => d.customer_name || '', 'Dt:', (d) => d.date ? fmtDate(new Date(d.date)) : ''],
  ['Product ID:', (d) => d.product_id || '', 'Dwg. No:', (d) => d.drawing_no || ''],
  ['Product Specifications:', (d) => d.product_specifications || '', 'PDI No:', (d) => d.pdi_no || ''],
  ['Controller Sr.No:', (d) => d.controller_sr_no || '', 'Controller Type:', (d) => d.controller_type || ''],
],
```

`controller_sr_no` is a new field, playing the same role `motor_sr_no` plays for AutoNXT Motor — manually entered per unit, **required before a batch member can be finalized** (`finalizeBatch`'s per-member loop gets the same check it already has for `motor_sr_no`, generalized to check whichever of the two fields is relevant to the batch's `template_id`, new error code `CONTROLLER_SR_NO_REQUIRED` alongside the existing `MOTOR_SR_NO_REQUIRED`).

5 fixed photo slots (`mode: 'fixed-slots'`, multi-photo per slot like AutoNXT Motor's):

```js
slots: [
  { key: 'overall_controller', label: 'Overall Controller Photo' },
  { key: 'name_plate', label: 'Controller Name Plate' },
  { key: 'can_io_card', label: 'CAN & I/O Card Inside Drive' },
  { key: 'harness_photo', label: 'Harness Photo' },
  { key: 'packing_photo', label: 'Packing Photo' },
],
```

## Pages & signature

2 pages (the reference document is "Pg 01 of 02" / "Pg 02 of 02"), not 3 like AutoNXT Motor:

- **Page 1**: header, Section A (Parameter Check), Remarks, signature block.
- **Page 2**: Section B (General Check), Remarks, Photos, signature block.

The reference document shows a `Prepared By` / `Approved By` signature row on **both** pages (unlike AutoNXT Motor, which signs once at the end on page 2) — a 2-role signature block (`prepared_by`, `approved_by`, no electrical/mechanical split, since there's no electrical/mechanical section distinction in this template) is repeated on each page, matching the reference document exactly.

## Lot/batch support

Entirely reused from the existing `pdi_report_batches` system — `POST /api/pdi/report-batches` with `template_id: 'autonxt_controller'` works with zero new batch-endpoint code, since the batch system was already built template-agnostic. The only batch-side change is the `motor_sr_no` → `controller_sr_no` finalize-check generalization noted above. Combined-PDF rendering reuses the same per-unit page-restart logic, since that logic lives in the batch-finalize merge step, not per-template.

## Web app

Two new components, directly mirroring the AutoNXT Motor pair:
- `AutoNXTControllerGeneratorForm.jsx` — single-report entry/editing. Revision-aware for finalized edits from day one (the `revisionNo`/`hasConflict` pattern built this session for the other three forms), not bolted on later.
- `AutoNXTControllerBatchForm.jsx` — creation + overview, same two-mode-in-one-component structure as `AutoNXTBatchForm.jsx`.
- New route(s) for both, same role restriction (`admin`, `production`) as AutoNXT Motor's routes.
- A link from the AutoNXT Motor form set suggesting the Controller form for controller units, if a natural place for one exists (mirroring the existing single-report → batch-creation cross-link) — minor, confirm placement during implementation rather than over-specifying here.

## Mobile app

Out of this repo's code — a handoff document goes to the app developer, same process as every other mobile PDI feature this session, covering:
- The template's field/section shape (Section A's repeatable parameter rows, Section B's fixed checklist, the 5 photo slots, `controller_sr_no`/`controller_type` header fields).
- The `CASHV38140` preset's 35 rows (same table as above), so the mobile app can seed Section A locally on report creation exactly like the web/backend do.
- The batch creation/overview API contract — already documented from the AutoNXT Motor batch work, this template just adds a second valid `template_id` value to the same endpoints.
- `GO`/`NG`/`NA` as the Measurement/Remarks quick-select suggestions.

## Testing

Same pattern as every PDI template/feature this session:
- New Jest coverage for the preset-seeding logic, the exact-match Remarks computation (including the manual-override case), the `CONTROLLER_SR_NO_REQUIRED` batch-finalize check, and the PDF renderer producing correct output for both sections.
- Live verification against production: create a real throwaway batch (clearly named), fill in and finalize several linked reports using this template, render to PNG and visually compare against the reference document's actual layout (header fields, Section A/B tables, photo slots, signature placement), then delete the throwaway data afterward — same safety pattern used for every prior live-verification round.
