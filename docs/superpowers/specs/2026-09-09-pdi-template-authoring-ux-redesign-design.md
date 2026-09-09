# PDI Template Authoring UX Redesign — Design Spec

**Date:** 2026-09-09
**Status:** Approved for implementation

## Problem

The PDI template authoring UI (`PdiTemplatesAdminPage.jsx`) lets an admin build a template's pages/sections, but the editor exposes the JSON dialect's own internal vocabulary directly: every field needs a hand-typed `dataKey`, table columns need a hand-picked "cell source" (`row` / `constant` / `sectionData`) with further raw sub-fields depending on the choice, and creating a template means hand-typing a URL-safe `id` slug. None of this is meaningful to someone who just knows what a PDI report should contain. This redesign makes the authoring experience approachable for a non-technical admin, prioritizing guidance and plain language over raw editing speed — the same priority this project used for the fill-out form redesign, applied here to the other half of the PDI template system.

This was brainstormed visually (mockups compared side-by-side, all approved as-shown); the chosen direction for each decision point is recorded below without re-litigating the alternatives.

## Scope

**In scope:**
- The template creation form (currently on `PdiTemplatesAdminPage.jsx`'s list view): auto-generates the template `id` from the entered name instead of asking for both.
- The deep editor (`TemplateEditor` and everything inside it): every section-type editor, the section list itself, and a new persistent live preview pane.
- A small, closely-related fix found while rebuilding this page: there is currently no way to remove a page once added (`+ Add page` has no counterpart) — added here since it's the same "page/section structure editing" surface this redesign already touches.

**Explicitly out of scope:**
- The fill-out/generator experience (`GenericPdiGeneratorForm.jsx` and friends) — already redesigned in a separate, completed project this session.
- The backend template model, versioning, and admin API (`AuthoredTemplates`, `pdi.admin.controller.js`, the `pdi_templates` table) — this redesign only changes how a definition gets *built* client-side; every save still goes through the existing `PUT`/`POST .../publish`/`POST .../archive` endpoints, unchanged.
- The PDF renderer (`renderer.js`, `authoredTemplate.js`) — unchanged. This matters concretely for the Checklist editor below.
- The list page's overall visual treatment beyond the creation form — it already received a pass earlier this session (status badges, delete button, hover states) and isn't revisited further here.

## Data keys and template IDs: auto-generated, hidden by default

**Field keys.** Every place a field currently needs a hand-typed `dataKey` (header info-field keys, table column keys, photo/image/signature/text `dataKey`s) instead takes only a plain-language label; the key is derived automatically via a shared slugify helper and never shown unless the admin expands that field's "Advanced" toggle.

`slugify(label)`: lowercase, trim, collapse any run of whitespace/non-alphanumeric characters to a single underscore, strip leading/trailing underscores. `"Customer Name"` → `customer_name`, `"PDI No."` → `pdi_no` — matching the existing hand-authored convention already used throughout this project's own templates (`customer_name`, `pdi_no`, `motor_sr_no`, etc.), so auto-generated keys look identical in shape to what a developer would have typed by hand.

**Collisions.** `dataKey`s must be unique within a template's whole definition (they're all flattened into one `data` object at fill-time). The key is recomputed live as the admin types the label (so the Advanced-toggle preview, if open, stays current), and re-checked for collisions at that same point: whenever a slugified key already exists anywhere else in the definition, append `_2`, `_3`, ... in order of creation — same disambiguation pattern already used for sidebar labels in the fill-out form redesign (`labelFlattenedSections`), reused here for consistency.

**Template `id`.** The creation form asks only for a `Name`; the `id` is slugified from it the same way, shown small and greyed-out next to the name field (not hidden entirely, since it's a one-time, low-frequency decision worth a glance), editable via the same kind of "Advanced" expansion. On `Create`, if the backend returns 409 (id already exists — `AuthoredTemplates.idExists`), automatically retry once with a `-2` suffix; if that also conflicts, reveal the id field directly with the 409 error shown inline, asking the admin to adjust it manually rather than silently retrying forever. The `id` stays permanent after creation, same as today — only creation-time generation is new.

## Table sections: two purpose-built editors, not one generic one

`TableSectionEditor` and `CellSourceEditor` are removed entirely, replaced by two editors selected via the section-type picker (see below) instead of a `mode` dropdown inside a shared editor:

**Checklist** (produces `{ type: 'table', mode: 'fixed', ... }`): a plain list of item names (each becomes one `fixedRows` entry, `key` auto-slugified from the item name). Every item shares one implicit result column with the exact three options **GO / NG / NA** — this is **not customizable in v1**, and the editor does not offer an "edit options" control despite what an early mockup implied during brainstorming. This is a deliberate constraint, not an oversight: the PDF renderer and the fill-out form's button toggle both hard-code recognition of exactly `['GO','NG','NA']` (case-insensitive) to decide whether to render a 3-way toggle at all (`renderer.js`'s drawer and `GenericPdiSections.jsx`'s `FixedTableSection`); a template built with different option labels would silently fall back to a plain text box downstream with no toggle, contradicting what a customizable-looking editor would have implied. Generalizing the renderer/fill-form to support arbitrary option sets is a real, separate, cross-cutting project (touches the PDF renderer, the fill-out form, and the dialect itself) and is out of scope here. The Checklist editor's column definition is therefore always exactly: `{ key: 'item', label: 'Item', cell: { source: 'row' } }, { key: 'result', label: 'Result', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } }` — generated by the editor, never exposed as configuration.

**Fill-in list** (produces `{ type: 'table', mode: 'repeatable', ... }`): a plain list of column labels (each becomes one column with `cell: { source: 'row' }`, auto-slugified `key`) — the inspector types a value per row under each at fill-time. An optional per-column "Always show this value" toggle, tucked under that column's own Advanced expansion, produces `cell: { source: 'constant', value }` for the rare case a repeatable table needs a fixed value in every row (e.g. a "Unit: pcs" column) — this is the one place `constant` sourcing survives in the new editors, since it has no Checklist equivalent and dropping it would remove real existing capability. `filterKey` (skip a row at render time if this field is empty) becomes a per-column checkbox, "Skip empty rows in this column," under that column's own Advanced expansion — mutually exclusive across a table's columns (checking it on one column unchecks any other), since the dialect only supports one `filterKey` per table. Unchecked on every column by default (no `filterKey` set at all), matching a freshly-created Fill-in list having no filter until the admin deliberately opts one in.

## Every section type: plain names, icons, one-line descriptions

The "+ Add section" control becomes a picker of labeled options instead of a bare `<select>` defaulting to `emptySection('header')`:

| Shown as | Produces | One-line description |
|---|---|---|
| Header | `type: 'header'` | Company details and top-of-page info like customer/date |
| Checklist | `type: 'table', mode: 'fixed'` | A fixed list of items the inspector marks GO/NG/NA |
| Fill-in list | `type: 'table', mode: 'repeatable'` | A list the inspector adds rows to, like serial numbers |
| Photos | `type: 'photo'` | Space for the inspector to attach photos |
| Image | `type: 'image'` | A single fixed image, like a nameplate |
| Signatures | `type: 'signature'` | Sign-off name fields |
| Notes | `type: 'text'` | A free-text remarks box |

("Notes" replaces "Text" as the display name only — the dialect's `type: 'text'` is unchanged.) Once a section exists, its type can no longer be changed in place (the current `SectionEditor`'s type `<select>` that silently resets a section via `emptySection()` is removed) — switching types was always destructive to whatever was configured, and is now handled the honest way: delete the section and add a new one of the desired type. This is a one-line simplification, not a capability loss (the destructive reset already discarded everything on type-change today).

**Header** simplification: the "info fields" list drops from six raw inputs per row (`leftLabel/leftKey/leftFormat/rightLabel/rightKey/rightFormat`) to four (`leftLabel`, left format as a text/date toggle, `rightLabel`, right format toggle) now that keys are auto-generated. The always-present `companyName`/`formatNo`/`revNo`/`effDate` fields keep their current labels (already plain print-document terms, not touched).

**Photo, Image, Signature, Notes**: no structural change beyond auto-generated keys (photo slot keys, image `dataKey`, signature role keys, text `dataKey`) replacing hand-typed ones, using the same label-in/key-hidden pattern throughout.

## Collapsible, drag-reorderable section cards

Each section renders as a card: collapsed by default to a one-line summary (type badge + name/title, matching the picker's plain-language type names), expands on click to that type's editor. `ListEditor` (the shared add/remove/reorder component already used for sections-within-a-page *and* every sub-list inside a section editor — info fields, checklist items, fill-in-list columns, signature roles, photo slots) gains real drag-and-drop reordering via native HTML5 drag events (no new dependency — this codebase has none today, and native drag-and-drop already has one precedent this session, the fill-out form's photo drag-and-drop), replacing the current up/down chevron buttons everywhere it's used. Extending this to every `ListEditor` usage (not just section cards) is a deliberate, low-incremental-cost generalization once the mechanism exists in the one shared component — the same reasoning already used for extending drag-and-drop to `ImageUploadCard`'s three consumers earlier this session.

**Page removal** (the small fix noted in Scope): each page gets a "Remove page" action. If the page has zero sections, it removes immediately; if it has any sections, a `window.confirm` guards it (matching this codebase's established destructive-action pattern, e.g. `PdiReportsTable.jsx`'s delete confirmation) — a page can't be un-removed once its sections are gone, unlike everything else in this editor which only discards a section's *configuration*, not report data.

## Live preview pane

A pane pinned to the right of the editor (matching the approved layout mockup) replaces the current "Preview PDF" button-that-opens-a-new-tab. It reuses the existing `POST /api/pdi/admin/templates/:id/preview` endpoint unchanged (already accepts an arbitrary `{ definition }` and returns a rendered PDF `Blob` — this is the same endpoint the current button already calls via `PDIGenerator.previewFromDefinition`). On any definition change, debounce 800ms, then POST the current definition and swap in the returned PDF via a `<iframe>` pointing at a blob URL (browsers render PDFs natively in an iframe; no PDF-rendering library needed), revoking the previous blob URL on each replacement to avoid leaking memory over a long editing session — same `URL.createObjectURL`/`revokeObjectURL` pairing already used elsewhere in this codebase for PDF downloads.

A definition that's mid-edit and therefore invalid (e.g. a fixed-table section with zero checklist items) will `400` from the backend's own existing validation (`previewFromDefinition`'s error path, already exercised by today's button) — the pane shows that error message inline in place of the PDF rather than erroring the whole page, and simply keeps showing the last successfully-rendered preview underneath a small "can't preview — <message>" notice so the admin isn't staring at a blank pane for every single keystroke of an in-progress edit.

## Guidance depth

Light touch, per the brainstorm: realistic placeholder text in inputs (e.g. a label input shows placeholder `"e.g. Customer Name"`), each section-type picker option carries its one-line description (see table above) and nothing more elaborate — no persistent hint blocks that stay visible once an admin already knows the tool.

## File structure

- `PdiTemplatesAdminPage.jsx` — trimmed to the list view (unchanged from earlier this session) + the creation form (now with auto-slug) + `TemplateEditor`'s own orchestration (name field, the page list, save/publish/archive actions, wiring the preview pane to the current `definition` state).
- `PdiTemplateSectionEditors.jsx` (new) — every per-type editor: `HeaderSectionEditor` (simplified), `ChecklistSectionEditor` (new), `FillInListSectionEditor` (new), `PhotoSectionEditor`, `ImageSectionEditor`, `SignatureSectionEditor`, `NotesSectionEditor` (renamed `TextSectionEditor`), plus the shared `ListEditor` (now with drag-and-drop) and the section-type picker.
- `PdiTemplatePreviewPane.jsx` (new) — the debounced-fetch, blob-URL, error-fallback live preview component described above.
- `src/utils/pdiTemplateSlug.js` (new) — the `slugify`/disambiguation helper, shared between the creation form's `id` generation and every field-key generation inside `PdiTemplateSectionEditors.jsx`.

## Testing

No automated test suite exists for this frontend (confirmed earlier this session — no `test` script in `package.json`); verification is lint + build + a personal live pass, matching this project's established pattern. The live pass should specifically cover: creating a template by name only (confirm the auto-generated id, confirm a deliberate id collision retries then surfaces the advanced field), building one section of each of the 7 types via the picker and confirming the live preview updates for each, dragging to reorder both sections and a sub-list (e.g. checklist items), removing an empty page and a non-empty page (confirming the confirm-dialog on the latter), and confirming a template built entirely through the new editors still fills out and finalizes correctly through the (already-redesigned, unrelated) fill-out form — i.e. that the generated dialect JSON is indistinguishable from what the old editor would have produced for the same intent.
