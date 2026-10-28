# PDI (Pre-Dispatch Inspection) Subsystem: Technical Notes

Paths are relative to `CRM_BACKEND/` unless they start with `CRM/` (the web frontend). This describes the code as it is at commit `e353328d` (2026-10). Where a design spec says something different from the code, these notes follow the code and say so.

---

## 1. Overview

The PDI subsystem records a product's pre-dispatch inspection (electrical and mechanical measurements, checklists, photos, sign-offs) and produces a customer-facing A4 PDF. It serves three clients through one REST API:

- **Web CRM** (React): hand-coded fill-out forms for each built-in template, a generic form for admin-authored templates, lot (batch) pages, a reports table, and an admin template editor.
- **Mobile PDI app** (React Native / Expo, a separate repo `pdi-erp-app`), used by technicians on the shop floor.
- **Background jobs** inside the API itself: Google Drive backup, a PDF disk cache, and Socket.IO change events.

Main building blocks:

| Layer | Files |
|---|---|
| Routes | `routes/operations/pdi.js`, `pdiReports.js`, `pdiReportBatches.js`, `pdiAdmin.js` (mounted in `server.js` lines 196-202) |
| Access control | `middleware/pdiAccess.js`, `middleware/auth.js` |
| Controllers | `controllers/operations/pdi.controller.js`, `pdiReports.controller.js`, `pdiReportBatches.controller.js`, `pdi.admin.controller.js` |
| Models | `models/operations/pdiReports.js`, `pdiReportBatches.js`, `pdi_generator.js` |
| Template engine | `models/operations/pdi/` (`renderer.js`, `primitives.js`, `tolerance.js`, `photoOptimizer.js`, `pdfCache.js`, `batchOverrides.js`, `authoredTemplate.js`, `authoredTemplates.js`, `templates/{index,general,autonxt,autonxt_controller}.js`) |
| Migrations | `scripts/migrations/2026-09-*.js`, `2026-10-05-pdi-batch-indexes.js` |
| Tests | `tests/pdi_*.test.js` (22 files, Jest) |

Key libraries (`package.json`): `pdfkit ^0.17.2`, `sharp ^0.35.4`, `pg ^8.13`, `redis ^4.7`, `socket.io ^4.8`, `express ^4.19`, `jest ^29.7`.

Route mount order matters (`server.js` 196-202): `/api/pdi/reports`, `/api/pdi/report-batches` and `/api/pdi/admin/templates` are mounted **before** the catch-all `/api/pdi` router, so Express does not hand them to the template router.

The JSON body limit is raised to **40 MB** (`server.js` line 132) because saves carry base64 photos.

---

## 2. Template engine architecture

### 2.1 The two kinds of template

1. **Built-in (code-registered) templates.** These are JS objects in `models/operations/pdi/templates/`, registered in `templates/index.js` as a map from id to template:
   - `general` ("General", 3 pages: Electrical, Mechanical, Photos)
   - `autonxt` ("AutoNXT Motor PDI", 3 pages)
   - `autonxt_controller` ("AutoNXT Controller PDI", 2 pages, `pageNumberPad: 2`, `endOfReport: true`)

   They can contain JS closures: computed cell values, `isOutOfTolerance` predicates, `footerHeight(data)` functions, spec rows, and function defaults. They are **not versioned in the DB**, so `template_version` is `NULL` on their reports. Each has its own hand-coded web form.

2. **Admin-authored templates.** These are stored in the `pdi_templates` table as a declarative JSON `definition`, so they hold no closures. `authoredTemplate.js#hydrateTemplate()` converts a stored definition into the in-memory shape the renderer expects. All of them are filled in through one generic web form (`CRM/src/components/admin/GenericPdiGeneratorForm.jsx`).

Resolution order (`pdi_generator.js`):
- `templates[templateId]` is checked first. If it exists, the built-in template wins.
- Otherwise the code calls `AuthoredTemplates.getByVersion(templateId, templateVersion)` and then `hydrateTemplate(row.definition)`. If that returns nothing it throws `Unknown PDI template: <id>`.

Creating a template whose id collides with a built-in one is rejected with a 409 by `pdi.admin.controller.js#createTemplate`. A stale comment in `pdi_generator.js` still says this check has not been built. It has.

### 2.2 Section vocabulary (renderer)

`renderer.js` walks `template.pages[].sections[]` and dispatches each section by `type` through the `DRAWERS` map:

| Type | Purpose / notable options |
|---|---|
| `header` | Logo box (`logoAsset`, e.g. `compage_header_left.png`), "Pre Dispatch Inspection (PDI)" title, Format No / Rev No / Eff. Dt, optional `extraFormatLines`, company-name strip, and two-column `infoFields` rows `[leftLabel, fn(data), rightLabel, fn(data)]`. `rLabelW` sets the right-hand label width. |
| `table` | `mode: 'fixed'` (rows from `fixedRows(data)`, values usually from `sectionData = data[dataKey]`) or `'repeatable'` (one row per item of the `data[dataKey]` array, auto-paginated). Optional `title`, grouped two-level headers (`group`), `specRow` (a yellow "Specification" row; `labelSpan` merges leading columns), `wrap: true` columns that size the row to its text, `filterRow`, and `footerHeight`. |
| `photo` | `mode: 'freeform'` (list of `{label, images[]}`) or `'fixed-slots'` (`slots[{key,label}]`, each slot value is a URI string, an array of URIs, or null). Photos are drawn two per row with a "PHOTOS:" header on every page. Optional `imgHeight` (default 150 pt) and `footerHeight`. |
| `image` | A single fixed image (`data[dataKey]`) with a `placeholder` text and annotations as fallback. General uses it for the drawing on page 2. |
| `signature` | N equal-width role boxes. A role can supply `value(data)`. `reserveBelow` leaves space for END OF REPORT. Moves to a new page if it would cross the bottom margin. |
| `text` | A fixed 40 pt "Remarks" box. `default` is a string or `fn(data)` and is used when the value is blank. Text wraps within `maxHeight`. |

An unknown section type throws `Unknown PDI template section type: <type>`. An invalid table or photo mode throws a descriptive error.

Out-of-tolerance cells are drawn with a light-red fill `#fee2e2`, **bold** dark-red text `#b91c1c` (bold survives black-and-white printing), driven by each column's `isOutOfTolerance(row, data)`.

Page numbering: `renderTemplate(doc, template, data, {numberPages})` draws "Pg X of N" using `drawPageNum`. `numberPageRange(doc, start, count)` numbers a sub-range starting again at 1, which is how the combined lot PDF restarts numbering for each unit. Each template's own `pageNumberPad` and `endOfReport` options are remembered per document in a `WeakMap`.

### 2.3 Primitives (`primitives.js`)

- **Page geometry:** A4, `PAGE_W 595.28`, `PAGE_H 841.89`, margin `M = 36`, `CW = PAGE_W - 72`, `BOT_M = 36`. The PDFKit document is created with `margins.bottom: 0`, `autoFirstPage: false` and `bufferPages: true`. Every draw call uses an explicit x/y; a non-zero bottom margin would make PDFKit insert blank pages.
- **Fonts:** Roboto Regular and Bold (`assets/fonts/`) are registered per document by `registerFonts(doc)`, with Helvetica / Helvetica-Bold as fallback. The font names are held in **module-level mutable state** (`F`, `FB`), read through `getFonts()`. Callers must not `await` between `registerFonts` and finishing drawing, or concurrent renders can leak font state into each other.
- **`t()`:** draws text at an explicit position, single line with ellipsis by default. `lb: true` wraps; `maxHeight` wraps and puts the ellipsis on the last line that fits. `stripEmoji()` removes emoji because the bundled fonts have no glyphs for them.
- **`decodeImageDataUri()`:** accepts only `data:image/(png|jpe?g);base64,...`. PNGs are pre-validated by `isDecodablePng()`, which re-inflates the IDAT chunks synchronously. PDFKit's own async zlib inflate throws an error that cannot be caught, so a corrupt PNG would otherwise crash the process.
- **`drawImageInBox()`:** wraps `doc.image` in a try/catch. A photo that fails to draw is labelled "Image could not be rendered".
- **`drawPaginatedRows()`:** repeatable-table pagination. The header is redrawn on each continuation page, and the last `KEEP_WITH_FOOTER = 3` rows always share a page with the footer (remarks and signatures).
- **`resolveCols()`:** columns without a width share the remaining width, with a 40 pt floor.
- **`fmtDate()`:** formats as DD/MM/YYYY in UTC.

### 2.4 Authored-template definition format (declarative dialect)

A stored `definition` is `{ pages: [ { sections: [...] } ] }`. Hydration rules (`authoredTemplate.js`):

- **header**: `infoFields` is an array of `{leftLabel, leftKey, leftFormat?, rightLabel, rightKey, rightFormat?}`. A format of `'date'` renders with `fmtDate`. Other keys: `companyName, formatNo, revNo, effDate, extraFormatLines, logoAsset, rLabelW, gap`. A missing `infoFields` throws.
- **table**: `mode`, `dataKey`, `title`, `headerHeight`, `rowHeight`, `gap`, `columns[{key,label,w,align,group,cell}]`. `cell` has exactly three shapes:
  - `{source:'row'}`: the default, `row[key]`
  - `{source:'sectionData', subfield, default}`: `sectionData[row.key][subfield] || default`
  - `{source:'constant', value}`

  Fixed mode uses stored `fixedRows: [{key,label,...}]`. Repeatable mode can set `filterKey` (keep a row only if that field is non-empty). Its `footerHeight` is computed automatically by summing the known heights of the sections that follow (text 40, signature 36, fixed table header + rows × rowHeight). If any following section's height cannot be known in advance, it adds a flat **150 pt** buffer instead.
- **image**: `dataKey, width, height, title, gap, placeholder{text, annotations}`.
- **photo, signature, text**: passed through unchanged.
- `buildSampleData(definition)` synthesises preview data (`pdi_no: 'PREVIEW-0000'`, "Sample" strings, 2 sample rows, GO results, "Sample Name" signatures) for the preview endpoint.

The admin editor (`CRM/src/components/admin/PdiTemplateSectionEditors.jsx`) offers section presets: Header, Checklist (fixed table with an Item column `{source:'row'}` and a Result column `{source:'sectionData', subfield:'measured', default:'GO'}`), Fill-in list (repeatable table), Photos, Image, Signatures and Notes (text). Field keys are generated from labels by `CRM/src/utils/pdiTemplateSlug.js` (`slugify`, `dedupeKey` adds `_2`, `_3` and so on). The editor warns when a template has no Header, Checklist or Signatures section (`PdiTemplatesAdminPage.jsx#missingTypicalSections`).

### 2.5 Versioning, publish and archive (`authoredTemplates.js`)

- `pdi_templates` is **append-only**. The primary key is `(id, version)`.
- `create()` inserts version 1 with status `draft`.
- `saveNewVersion(id, {name, definition, status})` always inserts `latest.version + 1`. Any field left out is copied from the latest row. `PUT` saves, `POST /:id/publish` sets `status='active'`, and `POST /:id/archive` sets `status='archived'`. Each of these creates a new version row. The web editor's "Publish" first PUTs the content and then POSTs publish, so it produces two version rows.
- `getActive(id)` returns the latest version **only if that latest row is active**. An earlier bug returned an older active row underneath a newer archived one, which effectively un-archived the template.
- `listActive()` returns, for each id, the latest version when it is active. It feeds the template picker. `listAll()` returns the latest version of each id regardless of status, for the admin list.
- When a report is created against an authored template, it pins `template_version` to the version that is active at that moment (`PdiReports.resolveTemplateVersion`). Later renders always use that exact version, even after the template is edited or archived.
- **Delete**: `DELETE /api/pdi/admin/templates/:id` hard-deletes every version, but only when no report uses the template (`PdiReports.countByTemplateId`). Otherwise it returns 409 and tells the admin to archive the template instead.
- A concurrent save that hits a duplicate `(id, version)` (Postgres error 23505) returns 409 "This template was just edited elsewhere".

---

## 3. Built-in template specifics

### 3.1 General (`templates/general.js`)

- **Page 1, Electrical.** Header (Format `CASPL/QA/F/14`). A repeatable `rows` table (columns: S.No, Motor Sr. No, Voltage, Current Measured F/R, RPM Measured F/R, Remarks) with a spec row built from `spec_current_display || spec_current_standard` and `spec_rpm_display || spec_rpm_specified`. A fixed `general_electrical` GO/NG checklist (5 rows). Remarks (default "ALL MOTORS OK, PASSED."). Signatures `prepared_by` and `approved_by`.
- **Page 2, Mechanical.** A drawing image placeholder. A repeatable `rows` table (Motor Length, Shaft Length, Shaft Diameter, PCD and MTG under a "Mounting Holes" group, Key Dim., Locating Dia., Remarks) with a spec row. A `general_mechanical` checklist (4 rows; the cable-length labels are interpolated from data). Remarks. Signatures `prepared_by_mechanical` and `approved_by_mechanical`, each falling back with `??` to the page 1 names for reports saved before app 1.0.8.
- **Page 3.** Freeform photos (`photos`).
- Only rows with a non-blank `motor_sr_no` are rendered.
- F/R readings such as "10.2/10.4" are split by `parseForwardReverse`, and **both** values are tolerance-checked.
- Spec text prints exactly as sent in `spec_X_display` (app 1.0.8+), with no bracketed range. Older reports fall back to the plain nominal.

### 3.2 AutoNXT Motor (`templates/autonxt.js`)

- Header (Format `CASPL/QA/F/23`, extra line "REV DT: 11/10/2024") plus a Motor Sr.No / Controller Type info row.
- **A. Performance Test @ No Load:** a fixed 8-row table (RPM 500 to 3000, 560 V). BEMF and Running Current each have a Specified column (wrapping) and a Measured column (tolerance-flagged). Values come from `data.performance_test[rpm_key].{bemf_measured,current_measured}`.
- **B. General Check:** 7 fixed GO/NG rows from `general_check`.
- **C. Physical Parameters:** 25 fixed rows from `physical_parameters[key].measured` (default "GO").
- Signatures (3 roles): `prepared_by_electrical`, `prepared_by_mechanical`, `approved_by`.
- Page 3: six fixed photo slots (`overall_motor`, `name_plate`, `sr_no_marked`, `power_cable_shielding`, `resolver_cable`, `front_rear_view`).
- `SPEC_DEFAULTS` holds 19 tolerance-eligible fields: 16 BEMF/current fields, plus `motor_total_length`, `shaft_op_length` and `locating_dia` (bilateral, −0.01/−0.05). For each field id:
  - `spec_<id>_display` is what prints.
  - `spec_<id>`, `_tol_mode`, `_tol` and `_tol_minus` drive the red flag only.

  The default applies when a report has no override. The one-off data fix `scripts/migrations/2026-09-30-fix-autonxt-spec-display.js` (supports `--dry-run`) rebuilt the stored `_display` values and calls `PdiReports.reRenderFinalizedReportForMaintenance`.

### 3.3 AutoNXT Controller (`templates/autonxt_controller.js`)

- Header (Format `CASPL/QA/F/26`, Rev 01) plus a Controller Sr.No / Controller Type row.
- **A. PARAMETER CHECK:** a repeatable `parameter_rows` table (S.NO, PARAMETER, SPECIFICATION, MEASURED VALUE, REMARKS). Rows are seeded from `CONTROLLER_TYPE_PRESETS` (currently only `CASHV38140`, 35 firmware parameters).
- `computeRemarks(row)`:
  - A stored remark that is not OK/NG (for example "NA") is an override and wins.
  - A blank measured value gives a blank remark.
  - If both values are plain decimals they are compared numerically (`1 = 0001 = 1.0`); otherwise by exact trimmed string.
  - NG flags both the Measured and Remarks cells.
- **B. General Check:** 10 fixed GO/NG rows. "NG" flags the cell.
- Remarks boxes default to "ALL OK, PASSED." only when their own section has no NG; otherwise they are blank.
- Page 2: five fixed photo slots (140 pt high), then signatures (`prepared_by`, `approved_by`) on both pages. Two-digit page numbers and "END OF REPORT" appear on the last page.

---

## 4. Tolerance evaluation and rounding (`models/operations/pdi/tolerance.js`)

`checkTolerance(measured, nominal, mode, tol, tol2)` returns `{outOfRange}`:

- `'±'` (symmetric): allowed range is `[nominal − |tol|, nominal + |tol|]`.
- `'%'`: `delta = |nominal| × |tol| / 100`.
- `'bilateral'`: `[nominal + min(tol, tol2), nominal + max(tol, tol2)]`. The min/max wrapping means a sign typed in either field cannot invert the range.
- Any mode other than `'bilateral'` is treated as symmetric or percentage, and `tol2` is ignored.
- A non-numeric measured value, a missing nominal, or a non-numeric tolerance means the check is **skipped** (`outOfRange: false`). It never throws or flags. This is why a "GO" in a tolerance-eligible row is never red.
- **Boundary rounding:** a float slack `EPS = 1e-9` is applied (`measured < low − EPS || measured > high + EPS`). Without it, `0.7 + 0.1 = 0.7999999999999999`, so a reading exactly on the 0.8 limit would be flagged. This was added in commit `0c077787`.
- The same formula is deliberately **duplicated in three places** and must stay identical: the backend, the web forms (`TOLERANCE_EPS` and `checkTolerance` in `CRM/src/components/admin/PDIGeneratorForm.jsx` and `AutoNXTGeneratorForm.jsx`), and the mobile app (`pdi-erp-app/src/services/tolerance.ts`).
- The web forms also rebuild display strings before every save: `formatSpecDisplay` in General gives "50 ±0.5", "3000 ±5%" or "50.0 +0.1/-0.2"; `formatAutoNxtSpecDisplay` does the same for AutoNXT.

---

## 5. Report lifecycle

### 5.1 Statuses (`pre_dispatch_inspection_reports.status`)

| Status | How it is set |
|---|---|
| `Pending` | `createReport`, `duplicateReport`, and every lot member created by `createBatch` |
| `In Progress` | PATCH with `status: 'In Progress'` (web forms send it on every save of a non-Completed report) |
| `Failed` | PATCH with `status: 'Failed'`, the mobile app's "Mark as failed" action. It was kept on purpose (commit `4d88e5eb`). |
| `Completed` | Set **only** by finalize (single report) or by lot finalize |

`ALLOWED_PATCH_STATUSES = ['Pending','In Progress','Failed']`. Any other value returns 400 `INVALID_STATUS`. `Failed` does not lock the report: a Failed report can still be edited and finalized.

Lot (`pdi_report_batches.status`) moves `In Progress → Finalizing → Completed`, falling back to `In Progress` if finalize fails or the server restarts.

### 5.2 Create, save and duplicate

- `POST /api/pdi/reports` validates the template id (`resolveTemplateVersion`; the default is `general`), parses `inspection_date`, and inserts a Pending row. `inspected_by` defaults to `req.user.name`.
- **Signer denormalisation:** `extractSignerNames(data)` scans the keys of `data` for `/prepared/i` and `/approved/i`, joins multiple matches with " / ", and stores the result in the `prepared_by` and `approved_by` columns. This happens on create and on every data PATCH. These columns are used for list search and sort.
- **Date validation:** an unparseable `inspection_date` throws `INVALID_INSPECTION_DATE` (400) before any write. An Indian day-first value such as "22-09-2026" used to produce an opaque 500 (report #1059). On a Completed report a malformed date is silently ignored.
- **PATCH merge:** `data` is shallow-merged in JS as `{...currentData, ...fields.data}`. This is a deliberate fix: Postgres `||` would wrap non-objects into an array. A `data` value that is not an object returns 400 `INVALID_DATA_PAYLOAD`. (Design spec 2026-10-01 proposed `data || $N`; the code does the JS merge instead.)
- **Photos write-skip:** `photos = CASE WHEN photos = $n::jsonb THEN photos ELSE $n::jsonb END` keeps the existing TOAST value when a client re-sends identical photos.
- Every PATCH to a non-Completed report runs `revision_no = revision_no + 1`. If the client sends `expected_revision`, it is added to the `WHERE` clause (optimistic concurrency).
- **Guarded UPDATE:** `WHERE report_id = $id AND status <> 'Completed' [AND revision_no = $r] AND LOT_OPEN_GUARD`. `LOT_OPEN_GUARD` requires either `batch_id IS NULL` or a lot still `In Progress`, using `FOR SHARE` so a concurrent lot finalize and a save are serialised. If no row matches, `#rejectedWriteState` picks the error: `BATCH_MEMBER_LOCKED`, `REPORT_LOCKED`, `REPORT_VERSION_CONFLICT`, or "Report not found".
- **Stale-screen rule** (commit `e353328d`): a PATCH that includes `status` on a report that is already `Completed` is refused with `REPORT_LOCKED` ("This report was finalized while you were editing"). Clients send `status` only while they believe the report is open.
- **Duplicate** (`POST /:id/duplicate`): creates a new Pending report with the same template, customer_id and order_id, empty photos, and data with the per-run keys removed. The removed keys depend on the template:
  - general: `pdi_no, date, rows, prepared_by, approved_by, general_electrical, general_mechanical, electrical_remarks, mechanical_remarks`
  - autonxt: `pdi_no, date, motor_sr_no, performance_test, general_check, physical_parameters, page1_remarks, page2_remarks, prepared_by_electrical, prepared_by_mechanical, approved_by`
  - autonxt_controller: `pdi_no, date, controller_sr_no, parameter_rows, general_check, page1_remarks, page2_remarks, prepared_by, approved_by`
  - authored templates: only `pdi_no` and `date`

  Header and spec fields carry over. Duplicating is the recommended way to "correct" a finalized report when the user is not permitted to edit it.

### 5.3 Finalize flow (single report): `PdiReports.finalizeReport`

1. Load the report including photos.
2. If it is a lot member, fail with `BATCH_MEMBER_USE_LOT` (409).
3. If `data.pdi_no` is missing, fail with `PDI_NO_REQUIRED` (400).
4. If it is already Completed, fail with `REPORT_LOCKED` (409).
5. Render: `PDIGenerator.generate(template_id, template_version, {...data, photos})`. The photos are optimised first (see §6).
6. Run a guarded `UPDATE ... SET status='Completed' WHERE status <> 'Completed' AND batch_id IS NULL`. If it loses a race it returns `REPORT_LOCKED`, and nothing is uploaded.
7. Respond immediately with the PDF bytes (`Content-Disposition: attachment; filename="PDI_<pdi_no>.pdf"`) and emit the Socket.IO event `pdiReportUpdate`.
8. In the background, without waiting:
   - Upload to Google Drive (`uploadBufferToDrivePrivate`, `PDI_<no>.pdf`) and store `drive_file_id`. If the report was deleted during the upload, the Drive file is deleted. This step never fails the finalize.
   - Write the disk cache with `pdfCache.write`.
9. The controller logs one timing line: photo count, loadMs, renderMs (with downscale ms/bytes), updateMs, pdfBytes, totalMs, and X-Request-ID.

The web forms always **save first, then finalize**, so the PDF matches the screen (`PDIGeneratorForm.jsx#handleFinalize`). They also show a confirm dialog with warnings before finalizing.

### 5.4 PDF download and cache

`GET /api/pdi/reports/:id/pdf` (`getPdfForDownload`):
- It reads only `status` and `pdi_no` first. A missing `pdi_no` returns 400 `PDI_NO_REQUIRED`.
- A Completed report is served from `pdfCache` when it is there (`source: 'cache'`).
- Otherwise the PDF is rendered. For a member of a Completed lot, the lot's authoritative fields (`getActiveBatchOverride`) are applied. A Completed report's render is then cached. Drafts are rendered every time and never cached.

`pdfCache.js`:
- Files live in `PDI_PDF_CACHE_DIR` or `os.tmpdir()/pdi-pdf-cache`, named `report-<id>.pdf` or `batch-<id>.pdf`.
- Writes go to a temp file that is then renamed. Reads check for the `%PDF-` header, and a corrupt file is deleted.
- LRU eviction by mtime keeps `MAX_FILES = 100` across both prefixes.
- Every operation is best-effort and never throws. The cache is emptied by a redeploy (it lives on the container's disk).

### 5.5 Editing a finalized report and the revisions table

Rule (`patchReport`, Completed branch; spec `docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md`):
- The caller's role must have `can_write` on module `PreDispatchInspectionReports` in the `permissions` table (`hasPermission(role_id, ...)` in `middleware/auth.js`). Otherwise the request fails with **403 `FINALIZED_REPORT_FORBIDDEN`**.
- `expected_revision` is required and must equal the current `revision_no`. Otherwise the request fails with **409 `REPORT_VERSION_CONFLICT`**.
- Only `data` (and therefore `prepared_by`/`approved_by`) and `photos` can change. `status`, `inspected_by`, `customer_id`, `order_id` and `inspection_date` are never added to the SET clause. An earlier version stripped them after the fact, which left an unbound parameter (Postgres error 42P18).
- Inside one transaction: a guarded `UPDATE ... WHERE status='Completed' AND revision_no=$cur AND LOT_OPEN_GUARD` (which bumps `revision_no`), then `INSERT INTO pdi_report_revisions (report_id, revision_no, data, edited_by)` with the **pre-edit** data. If the UPDATE matches no row, the transaction is rolled back, no audit row is written, and the request fails with `REPORT_VERSION_CONFLICT` (or `BATCH_MEMBER_LOCKED`).
- After the commit, `#reRenderFinalizedReport` runs in the background. It renders again, overwrites the cache, uploads a new Drive file, swaps `drive_file_id` under `SELECT ... FOR UPDATE`, and deletes the superseded Drive file. The background promise is attached as a non-enumerable `background` property so it never leaks into the JSON response.
- Because `LOT_OPEN_GUARD` applies here too, members of a finalized lot cannot be edited at all.
- Photos are not snapshotted in revisions.
- `GET /api/pdi/reports/:id/revisions` returns `[{revision_no, edited_by, edited_at, data}]`, newest first. It has no extra permission gate beyond PDI access.

### 5.6 Delete

`DELETE /api/pdi/reports/:id` is a single guarded statement: `DELETE ... WHERE report_id=$1 AND batch_id IS NULL AND (status <> 'Completed' OR $canWrite)`.
- Deleting any lot member fails with `BATCH_MEMBER_LOCKED`; the whole lot must be deleted from the lot page.
- Deleting a Completed report without `can_write` fails with `FINALIZED_REPORT_FORBIDDEN`.
- If the row changed in the meantime, it fails with `REPORT_VERSION_CONFLICT`.
- On success it removes the cache entry, makes a best-effort Drive delete, emits `pdiReportUpdate {status:'Deleted'}`, and returns `{report_id}`. Revision rows cascade.

### 5.7 Listing

`GET /api/pdi/reports?limit&cursor&offset&status&template_id&search&sortBy&sortDir`:
- `limit` is clamped to the range 1 to 100 (default 10).
- **Default ordering** is `report_id DESC` with keyset/cursor pagination (`cursor` = the last report_id).
- **Explicit sort** uses an allow-list of 7 keys: `sr_no, pdi_no, customer_name, status, prepared_by, approved_by, inspection_date`. It uses offset pagination, `NULLS LAST`, and `report_id` as a tie-breaker.
- **Search** is an ILIKE match over pdi_no, customer name (form value or linked customer), status, prepared_by, approved_by, motor_sr_no, controller_sr_no and the authored template name, plus built-in template names (matched in JS).
- **Response:** `{data:[{report_id, sr_no, status, template_id, template_name, customer_id, order_id, pdi_no, customer_name, inspected_by, prepared_by, approved_by, inspection_date, report_link, motor_sr_no, controller_sr_no, batch_id, lot_index, lot_quantity, batch_status, batch_pdi_no}], total, cursor, offset}`.

---

## 6. Photos: limits and optimisation

**Client side** (web):
- Crop to 4:3 and compress to a long edge of 1600 px, JPEG quality 0.85 (`CRM/src/utils/pdiImageUpload.js` and copies in each form).
- Raw file cap is 20 MB.
- Ceilings:

| Form | Photo ceiling |
|---|---|
| General (`PDIGeneratorForm.jsx`) | `MAX_PHOTOS = 12` slots, `MAX_IMAGES_PER_SLOT = 25`, `MAX_TOTAL_PHOTOS = 60`, `MAX_ROWS = 100` |
| AutoNXT and Controller forms | `MAX_IMAGES_PER_SLOT = 10` |
| Generic form (`GenericPdiSections.jsx`) | `MAX_PHOTOS = 12`, `MAX_ROWS = 100` |

- Saves are blocked client-side above `MAX_SAVE_PAYLOAD_BYTES = 35 MB`; the server limit is 40 MB.
- Forms send `photos` only when the photo signature has changed.

**Storage shapes:** freeform is `[{id, label, images:[dataURI]}]`. Fixed-slots is `{slotKey: dataURI | [dataURI] | null}`; AutoNXT originally stored a single string, and the renderer normalises both shapes.

**`?photos=summary`** on GET and PATCH: the server returns `photos` as `[{id, label, image_count}]`, computed inside Postgres (`photosSummarySql`), so the 20 to 40 MB photo value is never sent to Node or the phone. This is opt-in; app 1.0.8 and older still receive full photos. A PATCH still stores the photos in full.

**Server-side optimisation** (`photoOptimizer.js`, used for every render):
- `sharp` applies EXIF `.rotate()` (PDFKit ignores EXIF), resizes to fit inside **1000 px** without enlarging, flattens onto white, and encodes **JPEG quality 70**.
- **Concurrency is 4** (each decoded image is about 5.8 MB).
- If the result would be larger than the original, the original is kept.
- A photo that cannot be decoded is kept unchanged and only logs a warning.
- If `sharp` fails to load (its native binary is missing), photos pass through unchanged. The PDF is larger but not broken.
- Measured: a 60-photo PDF shrank from 21.6 MB to 8.1 MB, at about 22 ms per photo.
- Photos are found through every `photo` section's `dataKey` in the template (`photoDataKeys`).

---

## 7. Lots / batches (AutoNXT)

Spec: `docs/superpowers/specs/2026-09-29-autonxt-batch-reports-design.md`. Model: `models/operations/pdiReportBatches.js`.

- **Batchable templates:** `autonxt` and `autonxt_controller` only. Any other template fails with `TEMPLATE_NOT_BATCHABLE`.
- **Quantity:** an integer from 1 to 50 (`MAX_LOT_QUANTITY` is a technical safety cap). A digit string is accepted after trimming; values like "2.5", "1e1", "" or a boolean fail with `INVALID_LOT_QUANTITY`.
- **Create** (`POST /api/pdi/report-batches`): runs as one transaction. It inserts the lot row (status `In Progress`) and N member reports (`Pending`, `lot_index` 1 to N, `template_version` pinned, `photos '{}'`). Each member's data is `{pdi_no, ...shared}`. If any insert fails, the whole transaction rolls back. It emits `Pending` for each member.
- **Shared fields** (`batchOverrides.js#SHARED_FIELDS`): `customer_name, product_id, product_specifications, drawing_no, controller_type`. They are optionally seeded at creation (trimmed strings only). On a Controller lot, `controller_type` must be a key of `CONTROLLER_TYPE_PRESETS`, otherwise `INVALID_CONTROLLER_TYPE`; a Motor lot accepts free text.
- **Update** (`PATCH /:batchId`): only while the lot is `In Progress` (otherwise `BATCH_ALREADY_FINALIZED`). It takes the lot row with `FOR UPDATE`. A cleared field becomes `NULL` on the lot and `''` in each member's data. An empty `pdi_no` fails with `PDI_NO_REQUIRED`. The change is copied into every member's `data` in the same transaction, and each member's `revision_no` is bumped so open forms get a version conflict instead of writing old values back. The web forms treat these "lot fields" as read-only on member reports (`LOT_FIELDS` in `AutoNXTGeneratorForm.jsx`).
- **Delete** (`DELETE /:batchId`): only while `In Progress`. Members and the lot row are deleted in one transaction. Cache entries and Drive files are then cleaned up, and `Deleted` is emitted for each member.
- **Finalize** (`POST /:batchId/finalize`):
  1. A guarded flip `In Progress → Finalizing`. If the lot is already Finalizing this fails with `BATCH_FINALIZING`; if it is Completed, with `BATCH_ALREADY_FINALIZED`. While the lot is `Finalizing`, every member save is refused by `LOT_OPEN_GUARD`.
  2. Validate: the member count must equal `lot_quantity` (otherwise `BATCH_INCOMPLETE`). Every member must have a `motor_sr_no` (or `controller_sr_no` for a Controller lot). Missing values give `MOTOR_SR_NO_REQUIRED` or `CONTROLLER_SR_NO_REQUIRED`, with `lots: [indexes]` in the response body. Per-member `pdi_no` is no longer required.
  3. Render **one combined PDF** with `PDIGenerator.generateCombined` in lot_index order. The lot's `pdi_no` and any shared field that is set override each member's data. Photos are loaded **one unit at a time** through `loadPhotos()` to limit memory. Each unit's pages are numbered from "Pg 1 of N" again, matching the real Compage QA format. There is no PDF-merge library; PDFKit renders every unit into one document.
  4. In one transaction, mark every member that is not yet Completed as `Completed` (members already Completed, from older data, are skipped), and move the lot `Finalizing → Completed`.
  5. Remove each member's single-report cache entry, emit `Completed` for each member, and respond with the PDF (`PDI_BATCH_<pdi_no>.pdf`). In the background, back up to Drive (`PDI_BATCH_<no>.pdf`, stored in `pdi_report_batches.drive_file_id`) and write the cache entry `batch-<id>.pdf`.
  6. A `finally` block puts the lot back to `In Progress` on any failure before the commit, such as a bad photo or running out of memory.
- **Startup recovery** (`server.js` lines 103-109): on boot, `UPDATE pdi_report_batches SET status='In Progress' WHERE status='Finalizing'` resets lots left stuck by a crashed process. This is safe because only one container runs at a time.
- **Combined PDF download** (`GET /:batchId/pdf`): fails with `BATCH_NOT_READY` (409) unless the lot is Completed. It serves from cache, or re-renders with the same overrides and caches the result.
- **Member PDFs after the lot is finalized:** `getActiveBatchOverride(reportId)` applies the lot's `pdi_no` and shared fields when the lot is Completed. This lives in a separate leaf module to avoid a circular `require`.
- **List** (`GET /`): newest first, with `completed_count`, an optional `template_id` filter, and a limit defaulting to 20 (maximum 100).
- **Get** (`GET /:batchId`): returns the lot columns plus `reports[{report_id, lot_index, status, motor_sr_no, controller_sr_no, pdi_no}]`. Any id that is not 1 to 9 plain digits returns `Batch not found` without querying the database.
- **Web:** `CRM/src/components/admin/AutoNXTBatchForm.jsx` and `AutoNXTControllerBatchForm.jsx` (routes `/pdi-generator/autonxt-batch?batch=` and `/autonxt-controller-batch?batch=`) poll every 5 s while the lot is `Finalizing`. The reports table shows a "Lot i/N" chip linking to the lot page and hides Delete for lot members.

---

## 8. Access control

- **Authentication** (`middleware/auth.js#authenticateToken`): a JWT bearer token. The user and `role_name` are re-read from the database on every request.
  - No token: 401 `AUTH_NO_TOKEN`.
  - Bad token: 403 `AUTH_INVALID_TOKEN`.
  - Unknown user: 403 `AUTH_INVALID_USER`.
  - Database error during the user lookup: **503 `AUTH_UNAVAILABLE`**, so clients do not log the user out mid-inspection (commit `0c077787`).
- **PDI access** (`middleware/pdiAccess.js#requirePdiAccess`): only **admin and production** roles. Access is granted if the lowercased `roles.role_name` is in `{admin, production}` **or** the `role_id` maps to one of them (`{1:'admin', 5:'production'}`, mirroring `ROLE_MAP` in `auth.controller.js`). Anyone else gets **403 `PDI_FORBIDDEN`** "You don't have access to PDI reports." This deliberately does **not** use the `permissions` table, which has known gaps in its PDI rows. It is applied to every report, lot and template-picker route (commit `50eca80f`). Mobile technicians share the Production login and type their own names.
- **Template administration** (`routes/operations/pdiAdmin.js`): `req.user.role_id !== 1` gets 403 `{error:'Admin only'}`, with no error code.
- **Finalized edit and delete of a Completed report:** additionally gated by the `permissions` table (`PreDispatchInspectionReports.can_write`). See §5.5 and §5.6.
- **Web routes** (`CRM/src/routeConfig.jsx`):
  - `/pdi-generator` and all form and lot routes: `["admin","production"]`
  - `/pdi-templates`: `["admin"]`
  - `/pdi` (`PdiPage`): `["admin"]`
  - `/production-pdi` (`ProductionPDIPage`): `["production"]`

  Both list pages wrap `CRM/src/components/shared/PdiReportsTable.jsx`. `RESUME_ROLES = ['admin','production']` controls the Resume, Duplicate and Delete buttons.

---

## 9. Database tables and key columns

### `pre_dispatch_inspection_reports`
This is a legacy table that was extended. Its original columns include `report_id` (PK), `sr_no`, `customer_id`, `order_id`, `status`, `inspected_by`, `inspection_date`, the legacy `report_link`, and `created_at`. Columns added later:

| Column | Source |
|---|---|
| `data JSONB NOT NULL DEFAULT '{}'`, `photos JSONB NOT NULL DEFAULT '[]'`, `template_id TEXT NOT NULL DEFAULT 'general'`, `drive_file_id TEXT` | `2026-09-04-add-pdi-report-content.js` |
| `template_version INT` (NULL for built-in templates) | `2026-09-08-add-pdi-templates.js` |
| `batch_id INT REFERENCES pdi_report_batches`, `lot_index INT` | `2026-09-29-add-pdi-report-batches.js` |
| `revision_no INT NOT NULL DEFAULT 1` | `2026-09-30-add-pdi-report-revisions.js` |
| `prepared_by TEXT`, `approved_by TEXT` (denormalised signers) | Added by an ad-hoc `ALTER` in `docs/superpowers/plans/2026-09-16-pdi-dataset-wide-search-sort-filter.md`. **There is no migration file** for these in `scripts/migrations/`. |
| Indexes `idx_pdi_reports_batch_id`, and unique partial `uq_pdi_reports_batch_lot_index (batch_id, lot_index) WHERE batch_id IS NOT NULL` | `2026-10-05-pdi-batch-indexes.js` |

The API payload (`#toPayload`) also adds `report_link: /api/pdi/reports/:id/pdf`, `lot_quantity`, `batch_status` and `batch_pdi_no`, taken from a scalar subquery on the lot.

### `pdi_templates`
`id TEXT`, `version INT`, `name TEXT`, `status TEXT CHECK IN ('draft','active','archived') DEFAULT 'draft'`, `definition JSONB`, `created_by INT REFERENCES users`, `created_at`. The primary key is `(id, version)`, with index `idx_pdi_templates_id_version (id, version DESC)`.

### `pdi_report_batches`
`batch_id SERIAL PK`, `template_id TEXT`, `pdi_no TEXT`, `lot_quantity INT`, `status TEXT DEFAULT 'In Progress'` (In Progress, Finalizing or Completed; there is no CHECK constraint), `drive_file_id`, `created_by INT REFERENCES users`, `created_at TIMESTAMPTZ`. Shared fields added by `2026-09-30-add-pdi-batch-shared-fields.js`: `customer_name`, `product_id`, `product_specifications`, `drawing_no`, `controller_type`.

### `pdi_report_revisions`
`revision_id SERIAL PK`, `report_id INT REFERENCES pre_dispatch_inspection_reports ON DELETE CASCADE`, `revision_no INT` (the revision that the snapshot **was**), `data JSONB` (the pre-edit data), `edited_by INT REFERENCES users`, `edited_at TIMESTAMPTZ`.

The `permissions` table row for module `PreDispatchInspectionReports` (`can_write`) is used for finalized edits and deletes.

---

## 10. API endpoint reference

All endpoints require `Authorization: Bearer <JWT>`. Errors from the reports and lots controllers are `{error, code}`, so a client can show `error` as-is and branch on `code`.

### Templates (`routes/operations/pdi.js`, PDI access)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/pdi/templates` | `[{id,name,version}]`: built-in templates followed by active authored ones |
| GET | `/api/pdi/templates/:id/definition[?version=N]` | Authored templates only; a built-in id returns 404. Returns `{id,name,version,definition}`. `?version` serves that exact version even if archived (used to edit an existing report against its pinned version). Without it, only the active version is served. |

### Reports (`routes/operations/pdiReports.js`, PDI access)
| Method | Path | Body / response |
|---|---|---|
| POST | `/api/pdi/reports` | `{customer_id?, order_id?, inspected_by?, inspection_date?, data?, photos?, template_id?}`. Returns 201 with the report payload (status Pending). |
| GET | `/api/pdi/reports` | List (§5.7) |
| GET | `/api/pdi/reports/:id[?photos=summary]` | Report payload: `report_id, sr_no, status, template_id, template_version, customer_id, order_id, inspected_by, inspection_date, report_link, drive_file_id, revision_no, batch_id, lot_index, lot_quantity, batch_status, batch_pdi_no, data, photos` |
| PATCH | `/api/pdi/reports/:id[?photos=summary]` | Any of `{status, inspected_by, inspection_date, customer_id, order_id, data, photos, expected_revision}`. Returns the updated payload. |
| GET | `/api/pdi/reports/:id/revisions` | `[{revision_no, edited_by, edited_at, data}]` |
| POST | `/api/pdi/reports/:id/duplicate` | Returns 201 with the new report payload |
| POST | `/api/pdi/reports/:id/finalize` | Returns `application/pdf` as an attachment |
| GET | `/api/pdi/reports/:id/pdf` | Returns `application/pdf` (cached or freshly rendered) |
| DELETE | `/api/pdi/reports/:id` | `{report_id}` |

### Lots (`routes/operations/pdiReportBatches.js`, PDI access)
| Method | Path | Body / response |
|---|---|---|
| GET | `/api/pdi/report-batches[?template_id&limit]` | `[{batch_id, template_id, pdi_no, lot_quantity, status, customer_name, created_at, completed_count}]` |
| POST | `/api/pdi/report-batches` | `{template_id ('autonxt' default), pdi_no, quantity, customer_name?, product_id?, product_specifications?, drawing_no?, controller_type?}`. Returns 201 with the lot plus `reports[{report_id, lot_index, lot_quantity}]`. |
| GET | `/api/pdi/report-batches/:batchId` | The lot plus `reports[]` |
| PATCH | `/api/pdi/report-batches/:batchId` | `{pdi_no?, ...shared}`. Returns the refreshed lot. |
| DELETE | `/api/pdi/report-batches/:batchId` | `{deleted:true, batch_id, report_ids}` |
| POST | `/api/pdi/report-batches/:batchId/finalize` | Returns the combined `application/pdf` |
| GET | `/api/pdi/report-batches/:batchId/pdf` | Returns the combined PDF (409 `BATCH_NOT_READY` until the lot is Completed) |

### Template administration (`routes/operations/pdiAdmin.js`, admin only, role_id 1)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/pdi/admin/templates` | Latest version of each id, any status |
| GET | `/api/pdi/admin/templates/:id` | Full latest row |
| POST | `/api/pdi/admin/templates` | `{id, name, definition}`. Returns 201 (v1, draft). Returns 400 if a field is missing, 409 if the id is reserved by a built-in template or already exists. |
| PUT | `/api/pdi/admin/templates/:id` | `{name?, definition?}` creates a new version |
| POST | `/api/pdi/admin/templates/:id/publish` and `/archive` | Creates a new version with status active or archived |
| POST | `/api/pdi/admin/templates/:id/preview` | `{definition}`. Returns an inline PDF rendered with sample data. A malformed definition returns 400 with the renderer's message. |
| DELETE | `/api/pdi/admin/templates/:id` | 204. Returns 409 if any report uses the template. |

**Side effects:**
- Every mutating report or lot call invalidates Redis keys `pdi_*` (best-effort; skipped if Redis is not ready) and emits the Socket.IO event `pdiReportUpdate {report_id, status}`. The web table listens for it.
- Saves slower than 5 s log a warning with the byte count.

---

## 11. Error codes

| Code | HTTP | Raised by |
|---|---|---|
| `INVALID_STATUS` | 400 | PATCH status not in Pending, In Progress or Failed |
| `INVALID_INSPECTION_DATE` | 400 | Unparseable date (create, or PATCH of a non-Completed report) |
| `INVALID_DATA_PAYLOAD` | 400 | `data` is not a JSON object |
| `PDI_NO_REQUIRED` | 400 | Finalize or PDF without `pdi_no`; lot create or update with an empty `pdi_no` |
| `UNKNOWN_TEMPLATE` | 400 | `Unknown PDI template: <id>` on create, or lot create |
| `FINALIZED_REPORT_FORBIDDEN` | 403 | Editing or deleting a Completed report without `can_write` |
| `PDI_FORBIDDEN` | 403 | Role is not admin or production |
| `REPORT_NOT_FOUND` | 404 | Report missing or non-numeric id |
| `REPORT_LOCKED` | 409 | Finalize of an already Completed report; save after the report was finalized; status sent for a Completed report |
| `REPORT_VERSION_CONFLICT` | 409 | Stale or missing `expected_revision`, or a concurrent edit |
| `BATCH_MEMBER_LOCKED` | 409 | Edit of a member of a non-open lot; delete of any lot member |
| `BATCH_MEMBER_USE_LOT` | 409 | Single-report finalize on a lot member |
| `INVALID_LOT_QUANTITY`, `TEMPLATE_NOT_BATCHABLE`, `INVALID_CONTROLLER_TYPE`, `MOTOR_SR_NO_REQUIRED`, `CONTROLLER_SR_NO_REQUIRED` | 400 | Lot validation. The serial-number errors include `lots: []`. |
| `BATCH_ALREADY_FINALIZED`, `BATCH_FINALIZING`, `BATCH_INCOMPLETE`, `BATCH_NOT_READY` | 409 | Lot state |
| `BATCH_NOT_FOUND` | 404 | Missing lot or malformed id |
| `INTERNAL_ERROR` | 500 | Anything else, returned as "Internal Server Error" |
| `AUTH_NO_TOKEN` 401, `AUTH_INVALID_TOKEN` 403, `AUTH_INVALID_USER` 403, `AUTH_UNAVAILABLE` 503 | | Authentication |

Admin template endpoints return plain `{error}` without a `code`.

---

## 12. Mobile-app compatibility notes

- **`X-App-Version` header:** the mobile app sends it on every request and the web app does not. On login, a request carrying it receives a **12 h** JWT instead of 1 h (`controllers/auth.controller.js`, `MOBILE_APP_TOKEN_TTL`), so a long on-site inspection does not expire mid-way. The header is self-declared, so it only widens the expiry window for someone who already has valid credentials.
- **`status: 'Failed'`** is still accepted on PATCH for the app's "Mark as failed" action (commit `4d88e5eb`, after a brief removal).
- **`?photos=summary`** is opt-in, so app 1.0.8 and older still receive full photos.
- **App 1.0.8 General fields** (`spec_*_display`, `prepared_by_mechanical`, `approved_by_mechanical`, a GO/NG PCD) render, and pre-1.0.8 reports keep their old output (`tests/pdi_general_v1_0_8.test.js`).
- **AutoNXT fixed-slot photos** accept both a single URI string (older app versions) and an array.
- **`AUTH_UNAVAILABLE` (503)** instead of 403 on a database outage stops the app from logging the user out.
- The app relies on the same `REPORT_LOCKED`, `REPORT_VERSION_CONFLICT` and `BATCH_*` codes and `{error, code}` shape. Saves re-send the full photo set, which the photo write-skip in §5.2 makes cheap.
- The 40 MB body limit and the free-text date handling (`INVALID_INSPECTION_DATE`) were both motivated by app behaviour.

---

## 13. Test coverage (`tests/pdi_*.test.js`, Jest)

Note: `*.test.js` files are gitignored but tracked, so a new test must be added with `git add -f`. Most tests mock `pool.query`; some assert on SQL text.

| File | Covers |
|---|---|
| `pdi_admin.test.js` | Admin-only gate on every endpoint; create v1 draft; built-in and duplicate id 409; append-only save; publish and archive with picker visibility; preview PDF and 400 for a malformed definition; list latest; version pinning of reports; delete with and without report history |
| `pdi_authored_templates.test.js` | Version model: getLatest, getActive after archive, listActive and listAll, getByVersion(null), deleteAll |
| `pdi_authored_template_adapter.test.js` | Hydration of the three cell sources, automatic footerHeight and the 150 pt fallback, unknown section type, buildSampleData preview, image placeholder |
| `pdi_template_renderer.test.js` | Every section type; pagination; invalid modes; spec-row `labelSpan` and auto-height; `wrap` columns; table titles; signature `value()`; per-range page numbering, pad and END OF REPORT; text defaults and wrapping; photo height, footer and undecodable labels; signature page break |
| `pdi_primitives.test.js` | Data-URI and corrupt-PNG checks, `resolveCols`, `fmtDate`, Roboto and Helvetica fallback, `stripEmoji`, `t()` ellipsis and wrapping, `drawPaginatedRows` keep-with-footer rule |
| `pdi_generator.test.js`, `pdi_generator_combined.test.js` | Template dispatch (code vs DB, wrong version), `pdi_no` required, combined render with per-unit numbering and lazy `loadPhotos` |
| `pdi_tolerance.test.js`, `pdi_autonxt_tolerance.test.js` | ±, %, bilateral, skip rules, EPS boundary; the 19 AutoNXT spec defaults, verbatim display text, red flagging |
| `pdi_autonxt_controller.test.js` | 35-row preset, `computeRemarks` rules, NG flagging, remarks defaults, 2-page layout, page padding and END OF REPORT |
| `pdi_general_v1_0_8.test.js` | 1.0.8 vs older General rendering |
| `pdi_finalize_pdf.test.js` | Finalize responds before the Drive upload; Drive failure tolerated; orphan cleanup; cache write; locks; race; no photos read back; timings; download cache behaviour; pdfCache round-trip, eviction and unwritable directory |
| `pdi_pdf_cache_prefix.test.js` | `report` and `batch` prefixes, shared eviction budget |
| `pdi_photo_optimizer.test.js` | Downscale, aspect ratio, never-bigger, PNG to JPEG, undecodable input, freeform and slot shapes, no mutation, sharp missing, PDF size reduction |
| `pdi_photos_summary.test.js` | `?photos=summary` on GET and PATCH, both photo shapes |
| `pdi_finalized_edit.test.js` | Permitted edit with revision bump, snapshot and background re-render; FORBIDDEN; missing or stale revision; race with no phantom audit row; transaction order; stale-status refusal; excluded fields; JS merge; getRevisions |
| `pdi_lot_rules.test.js` | Lot fields in payload and list; search, sort and cursor; PATCH lot guard and revision rules; 0-row explanations; BATCH_MEMBER_USE_LOT; controller error mapping; `requirePdiAccess` |
| `pdi_report_batches.test.js` | createBatch validation and atomicity; shared fields; controller type; getBatch id parsing; finalizeBatch (Finalizing flip, lazy photos, all error states, revert on failure, legacy Completed member, pdi_no and shared overrides); list, update, delete; combined PDF cache and re-render |
| `pdi_delete_report.test.js` | Guarded DELETE rules |
| `pdi_inspection_date.test.js` | Date parsing, and Completed reports ignoring a bad date |
| `pdi_auth_unavailable.test.js` | 503 on database failure, 403 on a bad token, pass-through |

---

## 14. Web frontend map (CRM)

| Component | Purpose |
|---|---|
| `components/shared/PdiTemplatePicker.jsx` (`/pdi-generator`) | Fetches `/api/pdi/templates`; goes straight to the form if there is only one template. Form URLs come from `utils/pdiRoutes.js` (`pdiFormPath`, `pdiBatchPath`), because built-in slugs differ from ids (`autonxt_controller` lives at `/pdi-generator/autonxt-controller`; the old path redirects). |
| `components/admin/PDIGeneratorForm.jsx` (General), `AutoNXTGeneratorForm.jsx`, `AutoNXTControllerGeneratorForm.jsx` | Hand-coded forms. Start a draft (POST), save (PATCH `?photos=summary` with `expected_revision` and status In Progress), save then finalize, download PDF, "Reload latest" after a conflict, resume via `?report=<id>`. Drafts that were never saved are deleted when closed. |
| `components/admin/GenericPdiGeneratorForm.jsx` (`/pdi-generator/:templateId`) plus `GenericPdiSections.jsx` and `GenericPdiSidebar.jsx` | Schema-driven form for authored templates. Fetches `/definition?version=` for existing reports. Data and photos are autosaved on separate debounced channels (about 1.5 s). Known limitation: on a Completed report the two channels can trigger a spurious `REPORT_VERSION_CONFLICT`. Keyed by templateId so the form remounts when the id changes. |
| `components/admin/AutoNXTBatchForm.jsx`, `AutoNXTControllerBatchForm.jsx` | Lot create, edit, finalize, download and delete; polls every 5 s while Finalizing |
| `components/admin/PdiTemplatesAdminPage.jsx`, `PdiTemplateSectionEditors.jsx`, `PdiTemplatePreviewPane.jsx` (`/pdi-templates`) | Admin authoring with a debounced live PDF preview through `/preview`. Id collisions are retried with numeric suffixes. |
| `components/shared/PdiReportsTable.jsx` (used by `admin/PdiPage.jsx` and `production/ProductionPDIPage.jsx`) | Reports table with search, status, template and sort filters, mobile cards, Resume, View PDF (disabled without a PDI No.), Duplicate, Delete (not shown for lot members), lot chip, and a live `pdiReportUpdate` socket listener |
| `utils/pdiImageUpload.js`, `utils/pdiTemplateSlug.js`, `utils/pdiRoutes.js` | Image crop and compress, key slugs, URL helpers |

---

## 15. Notable gotchas and caveats

- The font names in `primitives.js` are module-global. `renderOptimizedPdfDoc` awaits photo optimisation **before** `registerFonts` and then draws synchronously, so it is safe. `generateCombined` registers fonts once and then **awaits** (template lookup, `loadPhotos`, optimisation) between units, which breaks the "no await" rule its own comment states. In practice this is harmless, because every document registers the same names (`Roboto` and `Roboto-Bold`, or Helvetica when the asset files are missing).
- The comment in `authoredTemplate.js` says that `TEXT_H` and `SIG_H` duplicate the renderer's constants. The values match (40 and 36), but the comment's own wording swaps them ("36/40").
- `GenericPdiSections.jsx` still has a stale comment citing a 25 MB server limit; the actual limit is 40 MB.
- `prepared_by` and `approved_by` columns have no migration script in the repo.
- `pdi_report_batches.status` has no CHECK constraint.
- Several design specs (for example `2026-09-29-autonxt-batch-reports-design.md`, written before `requirePdiAccess` existed) describe the PDI routes as "no permission gate". That is no longer true.
