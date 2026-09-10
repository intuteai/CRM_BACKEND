# PDI Template Authoring — Guided Creation & Flexible Table Columns Design

## Problem

The PDI template authoring UX redesign shipped earlier this session (spec: `2026-09-09-pdi-template-authoring-ux-redesign-design.md`) replaced raw dialect vocabulary with plain-language editors, added a live PDF preview, drag-and-drop reordering, and a 7-type section picker. It was reviewed through five rounds of code review plus a controller-led live verification pass and works correctly.

Direct user testing after shipping found it still hard to use — by a *technical* user, which is a stronger signal than it sounds, since the whole point of this redesign was ease of use for a non-technical admin. A structured round of questions localized the difficulty to three things, which all trace back to one root cause: **the UI treats every new template as invented from nothing, when in practice an admin is almost always translating an existing paper or Excel inspection form into the system.**

1. **Blank page, no guidance.** A new template starts as an empty page with just a dashed "+ Add section" button — no starting point, no hint of what a PDI report typically needs.
2. **The section picker is abstract.** Header / Checklist / Fill-in list / Photos / Image / Signatures / Notes are just labels with one-line descriptions — there's no way to tell what a choice will actually produce, and no way to match it against a block on a physical form without already knowing the tool.
3. **Filling in a section is confusing**, specifically because of unclear terminology — confirmed against a checklist of actual current labels (Format No./Rev No./Eff. Date, "Checklist" vs "Fill-in list", the "Advanced" + "key" toggle, "Skip empty rows in this column" / "Always show this value") — **all of which were flagged as unclear**, not just one or two.

A fourth, separate gap surfaced by inspecting the "General" template (one of two hand-coded, pre-authoring-UI templates, at `CRM_BACKEND/models/operations/pdi/templates/general.js`): its Checklist-style tables aren't just Item + Result — they have extra columns (a constant "Specified" hint, a per-row free-text "Remarks"). The new Checklist editor can't build that; it's hard-locked to exactly two columns.

## Scope

**In scope:**
1. A "Duplicate" action as the primary way to start a new template.
2. Visual previews + concrete examples in the section-type picker.
3. A plain-language rewrite of every remaining unclear label, and moving the technical "key" concept out of the default view.
4. A flexible column system for both Checklist and Fill-in list tables: add/remove/name/reorder columns of four types (fixed value, per-row text, per-row number, per-row dropdown).

**Out of scope, deliberately:**
- **Column grouping/spanning headers** (e.g. General's "Mounting Holes" header spanning two sub-columns) and the **"spec row"** concept (an extra highlighted row above the data rows with computed values). Both exist in exactly two legacy, hand-coded templates and nowhere else. Building general-purpose UI for them would add real complexity to serve a case that isn't recurring; those two templates stay code-only.
- **Changing the Result column's own options** away from GO/NG/NA. This was already a deliberate, load-bearing decision in the prior redesign: `renderer.js` and `GenericPdiSections.jsx`'s fixed-table renderer both hard-code recognizing exactly `['GO','NG','NA']` (case-insensitive) to draw the 3-way button toggle. Letting admins redefine the result options themselves would require reworking that renderer path for no confirmed need — explicitly rejected when scoping this round (see "Flexible table columns" below for the narrower thing that *is* in scope: adding columns *around* the locked Result column).
- Any change to the autosave/dirty-tracking logic in `GenericPdiSections.jsx`. That file was hardened through five rounds of review earlier this session for a subtle class of race condition; this round only adds new rendering branches to it (see below), and must not touch the save-chain/signature-comparison logic already in place.

## 1. Duplicate-first creation

Every template row in the list view (`PdiTemplatesAdminPage.jsx`) gets a "Duplicate" action alongside the existing Edit/Delete. Clicking it:
1. Fetches the source template's full definition (already a `GET /api/pdi/admin/templates/:id` call — the same one `openEditor` already makes).
2. Builds a new name (`"<source name> (copy)"`) and auto-slugs an id from it via the existing `labelToKey`, with the same silent-retry-on-409 behavior the creation form already has.
3. POSTs to the existing `POST /api/pdi/admin/templates` endpoint with `{ id, name, definition: <cloned definition> }` — no new backend endpoint, no schema changes. This is the same call the creation form already makes; only the `definition` payload differs (copied instead of empty).
4. Opens the new copy directly in `TemplateEditor`, exactly like opening any other existing template — every section and field pre-filled from the source.

The existing "+ New Template" (blank, name-only) flow stays available for the genuinely-new case, but becomes visually secondary to Duplicate — it moves to a smaller/less prominent spot since duplicate is expected to be what most admins reach for. **Zero backend changes required.**

## 2. Section picker: previews + examples

Each of the 7 `AddSectionPicker` options gets, alongside its existing label:
- A small visual thumbnail sketch of what that section type produces (a miniature table, photo icon, signature-line icon, etc.) — not a live-rendered preview, a static illustrative sketch baked into the picker's own markup.
- A concrete "e.g." example replacing today's abstract one-line description — e.g. Checklist: *"e.g. 'Winding Check — GO/NG/NA'"*, Fill-in list: *"e.g. a growing list of serial numbers"*.

This lets an admin match a picker option against whatever's in front of them on paper by recognition, not by reading a definition.

## 3. Plain-language terminology pass

Rewrite every currently-flagged label:

| Current | Proposed |
|---|---|
| "Format No." | "Document Number" (placeholder: *e.g. FMT-QA-01*) |
| "Rev No." | "Revision Number" (placeholder: *e.g. 1*) |
| "Eff. Date" | "Effective Date" (placeholder: *e.g. 09-Sep-2026*) |
| "Skip empty rows in this column" | "Only print this row once it has a value" |
| "Always show this value" | (reword to something equally concrete — exact copy decided during implementation, principle is: describe the effect, not the mechanism) |
| "Checklist" / "Fill-in list" (as bare labels) | Keep the names, but the picker's new example captions (see §2) carry the disambiguating weight — no separate copy change needed here beyond what §2 already does |

**The "Advanced" + "key" toggle disappears from the default view entirely.** Today, every `LabeledKeyField` has its own per-field "Advanced" link that reveals a raw key text box — that's the single biggest piece of remaining technical surface, and it's repeated dozens of times across a template. Replace all of those per-field toggles with **one template-level "Show technical keys" toggle**, placed once in the `TemplateEditor` header. Off (default): no key inputs, no "Advanced" links anywhere. On: every field's key becomes visible/editable inline, using the same revealed-state UI that exists today per-field — just controlled by one switch instead of many. This preserves the rare, genuinely-needed case (e.g., an admin matching keys to an existing external PDF layout) without cluttering the default path.

## 4. Flexible table columns

Both `ChecklistSectionEditor` and `FillInListSectionEditor` gain the same column system: columns can be added, removed, named, and drag-reordered, and each column has one of four types:

- **Fixed value** — the same text on every row (today's "Always show this value" constant-cell concept, unchanged).
- **Text** — the inspector types a value per row (today's default for Fill-in list columns; new for Checklist's extra columns).
- **Number** — same as Text, but the fill-out form renders a numeric input instead of a text box. No new dialect concept — just an input-type hint on the column.
- **Dropdown** — the admin defines a list of options (e.g. "Pass/Fail/Retest"); the inspector picks one when filling out the report. New: the column definition carries an `options: string[]` list, editable via a small add/remove list in the column's Advanced panel.

**In Checklist specifically:** Item and Result become two special anchor columns — **always present, cannot be deleted**, but *can* be dragged to any position relative to the columns the admin adds around them (matching General's real layout, where a constant "Specified" column sits between Item and Result). Result's own options stay locked to GO/NG/NA regardless of where it sits in the column order — only its *position* is adjustable, never its options.

**Data plumbing note for implementation** (not a decision the admin makes, but a real technical distinction the eventual plan needs to get right): Checklist's fixed rows are template-defined, so a new per-row Text/Number/Dropdown column's inspector-entered value must live in `sectionData[fixedRow.key][columnKey]` — the same nested-lookup pattern the existing Result column already uses (`sectionData[row.key].measured`) — **not** the `row[key]`-on-the-row-object pattern Fill-in list uses (where rows are inspector-*added*, not template-fixed). Reusing Fill-in list's cell-source shape for Checklist's new columns would be wrong; they need their own `sectionData`-based shape, mirroring Result.

**Fill-out form changes required:** `GenericPdiSections.jsx` needs two new rendering branches — a numeric `<input>` for Number-type columns and a `<select>` (or small button-group, matching the existing GO/NG/NA toggle's visual style for consistency) for Dropdown-type columns, populated from that column's `options`. This applies to both the fixed-table renderer (`FixedTableSection`, used by Checklist) and the repeatable-table renderer (`RepeatableTableSection`, used by Fill-in list). **This is the one piece of this round that touches `GenericPdiSections.jsx`** — it must be additive only (new column-type branches in the per-cell rendering logic), with no changes to the autosave/save-chain/signature-comparison code already hardened there.

**PDF renderer:** no changes needed. `renderer.js` already prints whatever string value sits at a cell's data key, regardless of what fill-out-form widget produced it — a Number or Dropdown column's value renders exactly like any other column's value does today.

**`filterKey` ("only print this row once it has a value") continues to work unchanged** — it's keyed off the column's `key`, which is independent of the column's new `type`.

## Testing

No automated frontend test suite exists in this repo (confirmed in the prior redesign round) — verification is lint + build + live manual/browser verification, same as before. Given this round touches `GenericPdiSections.jsx`, the implementation plan should include an explicit controller-personal live-verification step covering: building a Checklist with an added constant column and an added per-row column (mirroring General's real layout), building a Fill-in list with a Number and a Dropdown column, filling both out through the (already-hardened) generator form, and confirming autosave still behaves correctly — no regression in the save-chain logic from five rounds of review earlier this session.
