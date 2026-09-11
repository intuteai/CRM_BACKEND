# PDI Template Authoring Guided Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PDI template authoring page genuinely easy for a non-technical admin — duplicate-first creation, a section picker with visual cues and concrete examples, a global "show technical keys" toggle replacing dozens of per-field toggles, flexible table columns (fixed/text/number/dropdown) for both Checklist and Fill-in list, and light orientation/completeness scaffolding.

**Architecture:** All frontend, in the same three files the prior authoring redesign touched (`PdiTemplatesAdminPage.jsx`, `PdiTemplateSectionEditors.jsx`, `PdiTemplatePreviewPane.jsx` — the last one unchanged), plus one small, additive touch to the fill-out form (`GenericPdiSections.jsx`) to render the two new column types. Zero backend changes — every save/publish/archive/preview/duplicate call goes through existing, unmodified endpoints.

**Tech Stack:** React (hooks + Context), Tailwind CSS, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-10-pdi-template-authoring-guided-creation-design.md`

---

## Before you start: three things that are easy to get wrong

**1. The global "Show technical keys" toggle uses React Context, not prop-drilling.** `LabeledKeyField` currently manages its own per-field `showAdvanced` state. The new design has ONE toggle at the top of `TemplateEditor` controlling every field's key visibility at once. Do this via a `ShowKeysContext` that `LabeledKeyField` reads directly with `useContext` — **not** by threading a `showKeys` prop through `PageEditor` → `SectionCard` → `SectionEditorFor` → every individual section editor → `LabeledKeyField`. The Context approach means only two places in the whole codebase change for this feature: `LabeledKeyField` itself, and the `TemplateEditor` that provides the value. Every other editor function's signature stays completely untouched.

**2. Checklist's Item and Result columns are locked but *positionable*.** They can never be deleted, and Result's own options stay GO/NG/NA forever — but they **can** be dragged to any position relative to whatever extra columns the admin adds (matching the real "General" template, where a constant "Specified" column sits between Item and Result). This needs `ListEditor` to grow an optional `canRemove(item, i)` predicate (defaulting to always-removable, so every other existing `ListEditor` call site is unaffected) — not a bespoke non-reusable list for Checklist's columns.

**3. Checklist's new per-row extra columns and Fill-in list's columns use different `cell.source` shapes, even though they share the same column-type UI.** Checklist's rows are template-fixed, so a new "Remarks" column's inspector-entered value must live in `sectionData[fixedRow.key][columnKey]` (mirroring how the existing Result column already works: `cell: {source:'sectionData', subfield, default}`). Fill-in list's rows are inspector-*added*, so its columns use `cell: {source:'row'}` (reading `row[columnKey]` directly). The shared `ColumnFormatFields` component (Task 3) takes an `editableSource` callback precisely so each caller can supply its own correct shape — never hardcode one inside the shared component.

**4. Task order matters and is not arbitrary.** The section picker (Task 5) builds a Checklist section via `[ITEM_COLUMN, RESULT_COLUMN]` — constants that Task 3 introduces. Task 3 must land before Task 5, not after, or the picker's own code won't compile. Follow the numbered order below exactly; do not reorder tasks to match the spec document's own section numbering, which is organized by topic, not by build dependency.

---

### Task 1: Global "Show technical keys" toggle

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`
- Modify: `src/components/admin/PdiTemplatesAdminPage.jsx`

- [ ] **Step 1: Add the Context and update `LabeledKeyField`**

In `src/components/admin/PdiTemplateSectionEditors.jsx`, change the import line at the top from:

```js
import { useState } from 'react';
```

to:

```js
import { createContext, useContext, useState } from 'react';
```

Add this export directly below `FIELD_CLS`:

```js
// One template-wide toggle controls whether every field's technical key is
// visible/editable, replacing what used to be a separate "Advanced" link
// per field (dozens of them across one template). LabeledKeyField reads
// this directly via Context rather than taking a prop, so none of the
// section-editor functions between TemplateEditor and LabeledKeyField need
// to know this setting exists or thread it through their own props.
export const ShowKeysContext = createContext(false);
```

Replace the entire `LabeledKeyField` function with:

```jsx
export function LabeledKeyField({ label, keyValue, usedKeysExcludingSelf, onChange, placeholder }) {
  const showKeys = useContext(ShowKeysContext);
  return (
    <div>
      <input
        className={FIELD_CLS}
        placeholder={placeholder}
        value={label}
        onChange={(e) => {
          const newLabel = e.target.value;
          onChange({ label: newLabel, key: labelToKey(newLabel, usedKeysExcludingSelf) });
        }}
      />
      {showKeys && (
        <input
          className={FIELD_CLS + ' mt-1 text-xs text-gray-500'}
          placeholder="key"
          value={keyValue}
          onChange={(e) => onChange({ label, key: e.target.value })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the toggle into `TemplateEditor`**

In `src/components/admin/PdiTemplatesAdminPage.jsx`, add `ShowKeysContext` to the import from `./PdiTemplateSectionEditors`:

```js
import {
  FIELD_CLS, ListEditor, AddSectionPicker, SectionEditorFor,
  sectionTypeOption, sectionCardTitle, ShowKeysContext,
} from './PdiTemplateSectionEditors';
```

In `TemplateEditor`, add state right after the existing `saving` state:

```js
  const [showKeys, setShowKeys] = useState(false);
```

Wrap the entire returned JSX in the provider and add the toggle checkbox next to the name/id row. Replace:

```jsx
  return (
    <div className="flex gap-4 items-start" style={{ minHeight: '70vh' }}>
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-center gap-3">
          <input className={FIELD_CLS + ' text-lg font-semibold'} value={name} onChange={(e) => setName(e.target.value)} />
          <span className="text-xs text-gray-400 shrink-0">id: {template.id}</span>
        </div>
```

with:

```jsx
  return (
    <ShowKeysContext.Provider value={showKeys}>
    <div className="flex gap-4 items-start" style={{ minHeight: '70vh' }}>
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-center gap-3">
          <input className={FIELD_CLS + ' text-lg font-semibold'} value={name} onChange={(e) => setName(e.target.value)} />
          <span className="text-xs text-gray-400 shrink-0">id: {template.id}</span>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0 ml-auto cursor-pointer">
            <input type="checkbox" checked={showKeys} onChange={(e) => setShowKeys(e.target.checked)} />
            Show technical keys
          </label>
        </div>
```

And close the provider at the very end of the function — replace the closing:

```jsx
      <div className="w-96 shrink-0 sticky top-4" style={{ height: '70vh' }}>
        <PdiTemplatePreviewPane templateId={template.id} definition={definition} />
      </div>
    </div>
  );
}
```

with:

```jsx
      <div className="w-96 shrink-0 sticky top-4" style={{ height: '70vh' }}>
        <PdiTemplatePreviewPane templateId={template.id} definition={definition} />
      </div>
    </div>
    </ShowKeysContext.Provider>
  );
}
```

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx src/components/admin/PdiTemplatesAdminPage.jsx`
Expected: no errors (the same 4 pre-existing `react-refresh/only-export-components` warnings are fine).

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx src/components/admin/PdiTemplatesAdminPage.jsx
git commit -m "feat: replace per-field key toggles with one template-wide Show technical keys switch"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 2: Duplicate template action

**Files:**
- Modify: `src/components/admin/PdiTemplatesAdminPage.jsx`

- [ ] **Step 1: Add the `Copy` icon import and a `duplicateTemplate` handler**

Change the lucide-react import line:

```js
import { Plus, Trash2, Upload, Archive, ChevronDown, ChevronUp } from 'lucide-react';
```

to:

```js
import { Plus, Trash2, Upload, Archive, ChevronDown, ChevronUp, Copy } from 'lucide-react';
```

In the default-exported `PdiTemplatesAdminPage` function, add this new handler directly after `deleteTemplate`:

```jsx
  const duplicateTemplate = async (t) => {
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates/${t.id}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load template to duplicate');
      const source = await res.json();
      const baseName = `${source.name} (copy)`;
      const baseId = labelToKey(baseName, []);
      const attempt = async (id) => {
        const createRes = await fetch(`${BASE_URL}/api/pdi/admin/templates`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ id, name: baseName, definition: source.definition }),
        });
        const body = await createRes.json();
        return { ok: createRes.ok, status: createRes.status, body };
      };
      let result = await attempt(baseId);
      // Duplicating the exact same template twice in a row would otherwise
      // 409 every time (both attempts derive the identical "(copy)" name/id)
      // -- one silent retry with a "-2" suffix covers that without bothering
      // the admin, matching the same pattern createTemplate already uses.
      if (!result.ok && result.status === 409) {
        result = await attempt(`${baseId}-2`);
      }
      if (!result.ok) throw new Error(result.body.error || 'Duplicate failed');
      notifySuccess('Template duplicated.');
      await refresh();
      setEditing(result.body);
    } catch (err) {
      notifyError(err.message);
    }
  };
```

- [ ] **Step 2: Add "Duplicate" as the primary row action, and collapse blank creation behind a secondary link**

Add new state near the other `creating*` state declarations:

```js
  const [showBlankCreate, setShowBlankCreate] = useState(false);
```

Replace the entire "Create a new template" block:

```jsx
        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <div className="text-sm font-semibold text-gray-700 mb-3">Create a new template</div>
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input className={FIELD_CLS} value={creatingName} onChange={(e) => handleNameChange(e.target.value)} placeholder="e.g. Acme Motor PDI" />
              <button type="button" onClick={() => setShowIdAdvanced((s) => !s)} className="text-[11px] text-gray-400 hover:text-gray-600 mt-0.5">
                {showIdAdvanced ? 'Hide id' : 'Advanced'}
              </button>
              {showIdAdvanced && (
                <input
                  className={FIELD_CLS + ' mt-1 text-xs text-gray-500'}
                  placeholder="id (auto-generated from the name if left blank)"
                  value={creatingIdOverride ?? labelToKey(creatingName.trim(), [])}
                  onChange={(e) => setCreatingIdOverride(e.target.value)}
                />
              )}
            </div>
            <button type="button" disabled={creating} onClick={createTemplate} className="flex items-center gap-1 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
              <Plus size={16} /> New Template
            </button>
          </div>
        </div>
```

with:

```jsx
        {!showBlankCreate ? (
          <button
            type="button"
            onClick={() => setShowBlankCreate(true)}
            className="text-sm text-gray-400 hover:text-gray-600 mb-6"
          >
            + Start a blank template from scratch
          </button>
        ) : (
          <div className="bg-white rounded-xl shadow p-4 mb-6">
            <div className="text-sm font-semibold text-gray-700 mb-3">Create a blank template</div>
            <div className="flex gap-2 items-end flex-wrap">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                <input className={FIELD_CLS} value={creatingName} onChange={(e) => handleNameChange(e.target.value)} placeholder="e.g. Acme Motor PDI" />
                <button type="button" onClick={() => setShowIdAdvanced((s) => !s)} className="text-[11px] text-gray-400 hover:text-gray-600 mt-0.5">
                  {showIdAdvanced ? 'Hide id' : 'Advanced'}
                </button>
                {showIdAdvanced && (
                  <input
                    className={FIELD_CLS + ' mt-1 text-xs text-gray-500'}
                    placeholder="id (auto-generated from the name if left blank)"
                    value={creatingIdOverride ?? labelToKey(creatingName.trim(), [])}
                    onChange={(e) => setCreatingIdOverride(e.target.value)}
                  />
                )}
              </div>
              <button type="button" disabled={creating} onClick={createTemplate} className="flex items-center gap-1 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
                <Plus size={16} /> Create
              </button>
              <button type="button" onClick={() => setShowBlankCreate(false)} className="text-sm text-gray-400 px-2 py-2">Cancel</button>
            </div>
          </div>
        )}
```

Then replace the row actions in the template list:

```jsx
              <div className="flex items-center gap-3 shrink-0 ml-4">
                <button type="button" onClick={() => openEditor(t.id)} className="text-sm text-amber-700 font-medium hover:text-amber-800">Edit</button>
                <button
                  type="button"
                  onClick={() => deleteTemplate(t)}
                  className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700"
                  title="Delete this template"
                >
                  <Trash2 size={15} />
                </button>
              </div>
```

with:

```jsx
              <div className="flex items-center gap-3 shrink-0 ml-4">
                <button
                  type="button"
                  onClick={() => duplicateTemplate(t)}
                  className="flex items-center gap-1 text-sm font-medium text-amber-700 border border-amber-300 rounded px-2.5 py-1 hover:bg-amber-50"
                >
                  <Copy size={14} /> Duplicate
                </button>
                <button type="button" onClick={() => openEditor(t.id)} className="text-sm text-gray-500 hover:text-gray-700">Edit</button>
                <button
                  type="button"
                  onClick={() => deleteTemplate(t)}
                  className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700"
                  title="Delete this template"
                >
                  <Trash2 size={15} />
                </button>
              </div>
```

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplatesAdminPage.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/PdiTemplatesAdminPage.jsx
git commit -m "feat: add Duplicate template action, demote blank creation to a secondary link"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 3: Checklist flexible columns

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`

This is the largest, highest-design-judgment task in the plan, and the one every later task in this plan depends on (Task 4 reuses its shared component; Task 5's picker references its two new constants). Read the "Before you start" notes at the top of this plan again before starting — points 2 and 3 both apply directly here.

- [ ] **Step 1: Extend `ListEditor` with an optional `canRemove` predicate**

Replace the entire `ListEditor` function with:

```jsx
export function ListEditor({ items, onChange, renderRow, newRow, addLabel, hideAddButton, getItemKey, canRemove }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const handleDrop = (dropIndex) => (e) => {
    e.preventDefault();
    setOverIndex(null);
    if (dragIndex === null || dragIndex === dropIndex) { setDragIndex(null); return; }
    const reordered = [...items];
    const [moved] = reordered.splice(dragIndex, 1);
    // Reinserting at dropIndex (unadjusted) lands `moved` at exactly index
    // dropIndex in the resulting array regardless of drag direction — no
    // special-casing needed. An earlier version subtracted 1 for downward
    // drags, which made dropping an item onto its very next sibling a no-op.
    reordered.splice(dropIndex, 0, moved);
    onChange(reordered);
    setDragIndex(null);
  };

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        // Optional: some lists have "anchor" rows that can be reordered but
        // never deleted (e.g. Checklist's Item/Result columns). Defaults to
        // always-removable so every pre-existing ListEditor call site (none
        // of which pass canRemove) behaves exactly as before.
        const removable = canRemove ? canRemove(item, i) : true;
        return (
          <div
            key={getItemKey ? getItemKey(item, i) : i}
            draggable
            onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); if (dragIndex !== null && dragIndex !== i) setOverIndex(i); }}
            onDragLeave={() => setOverIndex((cur) => (cur === i ? null : cur))}
            onDrop={handleDrop(i)}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            className={`flex items-center gap-2 border rounded p-2 transition-colors ${
              overIndex === i ? 'border-amber-400 bg-amber-50' : 'border-gray-200'
            } ${dragIndex === i ? 'opacity-40' : ''}`}
          >
            <span className="text-gray-300 cursor-grab shrink-0" title="Drag to reorder">
              <GripVertical size={14} />
            </span>
            <div className="flex-1">{renderRow(item, (updated) => onChange(items.map((it, idx) => (idx === i ? updated : it))))}</div>
            {removable && (
              <button type="button" onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="text-red-500 hover:text-red-700 shrink-0">
                <Trash2 size={16} />
              </button>
            )}
          </div>
        );
      })}
      {!hideAddButton && (
        <button
          type="button"
          onClick={() => onChange([...items, newRow()])}
          className="flex items-center gap-1 text-xs font-medium text-amber-700 border border-amber-300 rounded px-2 py-1 hover:bg-amber-50"
        >
          <Plus size={14} /> {addLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the shared column-type helpers and `ColumnFormatFields` component**

Add this new code directly above the `ChecklistSectionEditor` function (replacing the existing `CHECKLIST_COLUMNS` block — see Step 3 for what replaces it immediately below this):

```jsx
// The four column "types" an admin can choose for an editable (non-fixed)
// column, shared between Checklist's extra columns and every Fill-in list
// column. "Fixed value" isn't really a distinct dialect concept — it's just
// cell.source === 'constant' — but presenting it as a 4th type alongside
// Text/Number/Dropdown reads far more plainly than a separate checkbox next
// to a 3-way type picker would.
const COLUMN_FORMATS = [
  { value: 'text', label: 'Text (inspector types it per row)' },
  { value: 'fixed', label: 'Fixed value (same on every row)' },
  { value: 'number', label: 'Number (inspector types it per row)' },
  { value: 'dropdown', label: 'Dropdown (inspector picks from your list)' },
];

// Derives which of the four format choices a column is currently in.
// 'fixed' is detected from cell.source alone (a constant column's format
// hint, if any, is meaningless — it's never edited by the inspector at
// authoring-fill time, so number/dropdown validation doesn't apply to it).
function columnFormat(col) {
  if (col.cell?.source === 'constant') return 'fixed';
  if (col.format === 'number') return 'number';
  if (col.format === 'dropdown') return 'dropdown';
  return 'text';
}

// Shared column-type controls used by both ChecklistSectionEditor's extra
// columns and FillInListColumnRow (Task 4). `editableSource(col)` supplies
// the correct cell shape for a non-fixed column in the CALLER's context —
// Checklist's rows are template-fixed, so its editable columns must read
// from `sectionData[fixedRow.key][columnKey]` (matching the existing,
// locked Result column's own shape); Fill-in list's rows are
// inspector-added, so its columns read from `row[columnKey]` directly.
// This component never assumes either shape itself.
function ColumnFormatFields({ col, editableSource, onUpdateCol }) {
  const format = columnFormat(col);
  return (
    <div className="space-y-1.5">
      <select
        className={FIELD_CLS}
        value={format}
        onChange={(e) => {
          const next = e.target.value;
          if (next === 'fixed') {
            onUpdateCol({ ...col, cell: { source: 'constant', value: col.cell?.source === 'constant' ? col.cell.value : '' }, format: undefined, options: undefined });
          } else if (next === 'dropdown') {
            onUpdateCol({ ...col, cell: editableSource(col), format: 'dropdown', options: col.options && col.options.length ? col.options : [''] });
          } else if (next === 'number') {
            onUpdateCol({ ...col, cell: editableSource(col), format: 'number', options: undefined });
          } else {
            onUpdateCol({ ...col, cell: editableSource(col), format: undefined, options: undefined });
          }
        }}
      >
        {COLUMN_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      {format === 'fixed' && (
        <input
          className={FIELD_CLS}
          placeholder="Value shown in every row"
          value={col.cell.value}
          onChange={(e) => onUpdateCol({ ...col, cell: { source: 'constant', value: e.target.value } })}
        />
      )}
      {format === 'dropdown' && (
        <ListEditor
          items={col.options || []}
          onChange={(options) => onUpdateCol({ ...col, options })}
          addLabel="Add option"
          newRow={() => ''}
          renderRow={(opt, updateOpt) => (
            <input className={FIELD_CLS} placeholder="Option text" value={opt} onChange={(e) => updateOpt(e.target.value)} />
          )}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Replace `CHECKLIST_COLUMNS` with `ITEM_COLUMN`/`RESULT_COLUMN` and rewrite `ChecklistSectionEditor`**

Delete the existing:

```jsx
// The Checklist editor's hard-coded, non-configurable column shape. Shared
// between ChecklistSectionEditor (which rewrites it on every edit, below)
// and SECTION_TYPE_OPTIONS' checklist build() (further down this file) so a
// freshly-added, never-yet-edited Checklist section already has valid
// columns from the moment it's created via the picker — not only after the
// admin's first title/row edit. If these two ever used separately-written
// copies of this shape, they could drift.
const CHECKLIST_COLUMNS = [
  { key: 'item', label: 'Item', cell: { source: 'row' } },
  { key: 'result', label: 'Result', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } },
];
```

Replace it with:

```jsx
// Item and Result are the two mandatory anchor columns every Checklist
// has. Item always reads the row's own label (cell:{source:'row'} ->
// row.item); Result is permanently locked to the GO/NG/NA subfield. Extra
// columns the admin adds live alongside them in the same list and CAN be
// repositioned relative to Item/Result (matching real forms like the
// hand-coded "General" template, where a constant "Specified" column sits
// between the two) — they just can't be deleted. Shared with
// SECTION_TYPE_OPTIONS' checklist build() (Task 5, later in this file) so a
// freshly-added, never-yet-edited Checklist section already has valid
// columns from the moment it's created — not only after the admin's first
// edit.
const ITEM_COLUMN = { key: 'item', label: 'Item', cell: { source: 'row' } };
const RESULT_COLUMN = { key: 'result', label: 'Result', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } };
```

Now replace the entire `ChecklistSectionEditor` function with:

```jsx
// Produces { type: 'table', mode: 'fixed', ... }. The result column's
// OPTIONS are ALWAYS exactly GO/NG/NA — this is deliberately NOT
// configurable. Do not add a way to change what the three options ARE,
// even though it looks like an obvious enhancement: renderer.js and
// GenericPdiSections.jsx's FixedTableSection both hard-code recognition of
// exactly ['GO','NG','NA'] (case-insensitive) to decide whether to draw a
// 3-way toggle at all — a template with different option labels would
// silently fall back to a plain text box downstream with no toggle, which
// the editor gives no indication of. What IS configurable: extra columns
// around Item/Result (their position, and whether they're fixed/text/
// number/dropdown) — see the "Columns" list below.
export function ChecklistSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);
  (section.fixedRows || []).forEach((r) => { if (r.key) excludingThisSection.delete(r.key); });
  const columns = section.columns && section.columns.length ? section.columns : [ITEM_COLUMN, RESULT_COLUMN];
  columns.forEach((c) => { if (c.key && c.key !== 'item' && c.key !== 'result') excludingThisSection.delete(c.key); });

  return (
    <div className="space-y-2">
      <LabeledKeyField
        label={section.title || ''}
        keyValue={section.dataKey}
        usedKeysExcludingSelf={excludingThisSection}
        placeholder="e.g. Winding & Bearing Checks"
        onChange={({ label, key }) => onChange({ ...section, title: label, dataKey: key, columns })}
      />
      <p className="text-[11px] text-gray-400">Every item is marked GO / NG / NA by the inspector — this isn&apos;t customizable.</p>

      <div>
        <label className="text-xs font-medium text-gray-600">Columns</label>
        <ListEditor
          items={columns}
          onChange={(nextColumns) => onChange({ ...section, columns: nextColumns })}
          addLabel="Add column"
          newRow={() => ({ key: '', label: '', cell: { source: 'sectionData', subfield: '', default: '' } })}
          canRemove={(c) => c.key !== 'item' && c.key !== 'result'}
          renderRow={(col, update) => {
            if (col.key === 'item') {
              return (
                <div className="text-sm text-gray-700 py-1">
                  Item <span className="text-[10px] text-gray-400 ml-1">always the item name &middot; can&apos;t remove</span>
                </div>
              );
            }
            if (col.key === 'result') {
              return (
                <div className="text-sm text-gray-700 py-1">
                  Result (GO / NG / NA) <span className="text-[10px] text-gray-400 ml-1">fixed options &middot; can&apos;t remove</span>
                </div>
              );
            }
            const excludingThisCol = new Set(excludingThisSection);
            columns.forEach((c) => { if (c.key && c.key !== col.key && c.key !== 'item' && c.key !== 'result') excludingThisCol.add(c.key); });
            return (
              <div className="space-y-1">
                <LabeledKeyField
                  label={col.label}
                  keyValue={col.key}
                  usedKeysExcludingSelf={excludingThisCol}
                  placeholder="e.g. Remarks"
                  onChange={({ label, key }) => update({
                    ...col,
                    label,
                    key,
                    cell: col.cell?.source === 'constant' ? col.cell : { ...col.cell, subfield: key },
                  })}
                />
                <ColumnFormatFields
                  col={col}
                  editableSource={(c) => ({ source: 'sectionData', subfield: c.key, default: '' })}
                  onUpdateCol={update}
                />
              </div>
            );
          }}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-gray-600">Items</label>
        <ListEditor
          items={section.fixedRows || []}
          onChange={(fixedRows) => onChange({ ...section, fixedRows })}
          addLabel="Add checklist item"
          newRow={() => ({ key: '', item: '' })}
          renderRow={(row, update) => {
            // excludingThisSection already lacks every fixed row's own key
            // (removed up front above). Re-add every OTHER row's key here
            // so sibling checklist items can't collide with each other.
            const excludingThisRow = new Set(excludingThisSection);
            (section.fixedRows || []).forEach((r) => { if (r.key && r.key !== row.key) excludingThisRow.add(r.key); });
            return (
              <LabeledKeyField
                label={row.item || ''}
                keyValue={row.key}
                usedKeysExcludingSelf={excludingThisRow}
                placeholder="e.g. Winding Check"
                onChange={({ label, key }) => update({ key, item: label })}
              />
            );
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: one error, from `SECTION_TYPE_OPTIONS`' checklist entry still reading `columns: CHECKLIST_COLUMNS`, which this task just removed. Fix it now: change that one line from `columns: CHECKLIST_COLUMNS` to `columns: [ITEM_COLUMN, RESULT_COLUMN]`. This is the only other place `CHECKLIST_COLUMNS` was referenced.

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx` again.
Expected: no errors (the same 4 pre-existing `react-refresh/only-export-components` warnings are fine). Grep the file for `CHECKLIST_COLUMNS` to confirm it no longer appears anywhere.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: let Checklist sections have addable/reorderable extra columns around the locked Item/Result pair"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 4: Fill-in list column types

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`

Depends on Task 3 (`ColumnFormatFields`, `columnFormat`, `COLUMN_FORMATS`, and `ListEditor`'s `canRemove` support all need to already exist in the file).

- [ ] **Step 1: Rewrite `FillInListColumnRow` to use the shared `ColumnFormatFields`**

Replace the entire `FillInListColumnRow` function with:

```jsx
function FillInListColumnRow({ col, section, excludingThisCol, update, onSectionChange }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Every not-yet-named column shares the same empty-string key, so without
  // the Boolean(col.key) guard, checking "skip empty rows" on ANY blank
  // column would make every other blank column appear checked too.
  const isFilterCol = Boolean(col.key) && section.filterKey === col.key;
  return (
    <div className="space-y-1">
      <LabeledKeyField
        label={col.label}
        keyValue={col.key}
        usedKeysExcludingSelf={excludingThisCol}
        placeholder="e.g. Motor Sr.No"
        onChange={({ label, key }) => {
          // Renaming the key this table's filterKey points at must keep the
          // reference correct, not silently orphan it. If the rename clears
          // the key back to empty, clear filterKey too rather than pointing
          // it at the same collision-prone empty string.
          //
          // This must be ONE combined write, not update() (routes through
          // ListEditor -> FillInListSectionEditor's own onChange, which
          // recomputes filterKey from `section.filterKey` before this
          // column's rename has been applied) followed by a separate
          // onSectionChange call — two writes derived from the same
          // pre-update `section` snapshot race, and the second one
          // (columns-based recompute) always won, silently clearing a
          // filterKey that this rename was trying to preserve.
          const wasFilterCol = Boolean(col.key) && section.filterKey === col.key;
          const nextColumns = (section.columns || []).map((c) => (c === col ? { ...c, label, key } : c));
          onSectionChange({
            ...section,
            columns: nextColumns,
            filterKey: wasFilterCol ? (key || undefined) : section.filterKey,
          });
        }}
      />
      <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-[11px] text-gray-400 hover:text-gray-600">
        {showAdvanced ? 'Hide advanced' : 'Advanced'}
      </button>
      {showAdvanced && (
        <div className="space-y-1.5 pl-2 border-l-2 border-gray-100">
          <ColumnFormatFields
            col={col}
            editableSource={() => ({ source: 'row' })}
            onUpdateCol={update}
          />
          <label className={`flex items-center gap-1.5 text-xs ${col.key ? 'text-gray-600' : 'text-gray-300'}`} title={col.key ? undefined : 'Name this column first'}>
            <input
              type="checkbox"
              checked={isFilterCol}
              disabled={!col.key}
              onChange={(e) => {
                if (!col.key) return;
                onSectionChange({ ...section, filterKey: e.target.checked ? col.key : undefined });
              }}
            />
            Only print this row once it has a value
          </label>
        </div>
      )}
    </div>
  );
}
```

Note what changed: the old standalone "Always show this value" checkbox + conditional constant-value input are gone, replaced entirely by `<ColumnFormatFields>` (which now covers fixed/text/number/dropdown in one control). The "Skip empty rows in this column" checkbox is renamed to "Only print this row once it has a value" and otherwise unchanged.

- [ ] **Step 2: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors. In particular, no `react-hooks/rules-of-hooks` error — `ColumnFormatFields` is a real, separate, module-level function component (defined in Task 3), rendered via JSX (`<ColumnFormatFields ... />`), not called as a plain function.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: let Fill-in list columns be text/fixed/number/dropdown, matching Checklist's new column types"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 5: Section picker — icons and concrete examples

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`

Depends on Task 3 (`ITEM_COLUMN`/`RESULT_COLUMN` must already exist).

- [ ] **Step 1: Import the new icons**

Change:

```js
import { Plus, Trash2, GripVertical } from 'lucide-react';
```

to:

```js
import { Plus, Trash2, GripVertical, FileText, CheckSquare, Table, Camera, Image, PenLine, StickyNote } from 'lucide-react';
```

- [ ] **Step 2: Give each `SECTION_TYPE_OPTIONS` entry an icon and a concrete example**

Replace the `description` field on every entry with `icon` + `example`. Replace the whole array:

```js
export const SECTION_TYPE_OPTIONS = [
  { value: 'header', label: 'Header', icon: FileText, example: 'e.g. company name, customer, date', build: () => ({ type: 'header', companyName: '', formatNo: '', revNo: '', effDate: '', extraFormatLines: [], logoAsset: null, infoFields: [] }) },
  { value: 'checklist', label: 'Checklist', icon: CheckSquare, example: 'e.g. "Winding Check — GO/NG/NA"', build: () => ({ type: 'table', mode: 'fixed', title: '', dataKey: '', columns: [ITEM_COLUMN, RESULT_COLUMN], headerHeight: 20, rowHeight: 14, fixedRows: [] }) },
  { value: 'fillInList', label: 'Fill-in list', icon: Table, example: 'e.g. a growing list of serial numbers', build: () => ({ type: 'table', mode: 'repeatable', title: '', dataKey: '', columns: [], headerHeight: 20, rowHeight: 14, filterKey: undefined }) },
  { value: 'photo', label: 'Photos', icon: Camera, example: 'e.g. nameplate photo, damage photos', build: () => ({ type: 'photo', mode: 'freeform', dataKey: '', label: '', slots: [] }) },
  { value: 'image', label: 'Image', icon: Image, example: 'e.g. a fixed reference image', build: () => ({ type: 'image', dataKey: '', width: null, height: 100, title: '', placeholder: null }) },
  { value: 'signature', label: 'Signatures', icon: PenLine, example: 'e.g. "Inspected By ___________"', build: () => ({ type: 'signature', roles: [] }) },
  { value: 'notes', label: 'Notes', icon: StickyNote, example: 'e.g. a free-text remarks box', build: () => ({ type: 'text', label: '', dataKey: '', default: '' }) },
];
```

- [ ] **Step 3: Update `AddSectionPicker` to render the icon and example**

Replace:

```jsx
      {SECTION_TYPE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => { onAdd(opt.build()); setOpen(false); }}
          className="w-full text-left px-3 py-2 rounded hover:bg-amber-50 flex flex-col"
        >
          <span className="text-sm font-medium text-gray-800">{opt.label}</span>
          <span className="text-xs text-gray-500">{opt.description}</span>
        </button>
      ))}
```

with:

```jsx
      {SECTION_TYPE_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => { onAdd(opt.build()); setOpen(false); }}
            className="w-full text-left px-3 py-2 rounded hover:bg-amber-50 flex items-center gap-3"
          >
            <span className="shrink-0 w-8 h-8 rounded bg-amber-100 text-amber-700 flex items-center justify-center">
              <Icon size={16} />
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-medium text-gray-800">{opt.label}</span>
              <span className="text-xs text-gray-500">{opt.example}</span>
            </span>
          </button>
        );
      })}
```

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: add icons and concrete examples to the section-type picker"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 6: Header field terminology rewrite

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`

- [ ] **Step 1: Rewrite the three abbreviated Header placeholders**

In `HeaderSectionEditor`, replace:

```jsx
        <input className={FIELD_CLS} placeholder="Format No." value={section.formatNo} onChange={(e) => onChange({ ...section, formatNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Rev No." value={section.revNo} onChange={(e) => onChange({ ...section, revNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Eff. Date" value={section.effDate} onChange={(e) => onChange({ ...section, effDate: e.target.value })} />
```

with:

```jsx
        <input className={FIELD_CLS} placeholder="Document Number (e.g. FMT-QA-01)" value={section.formatNo} onChange={(e) => onChange({ ...section, formatNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Revision Number (e.g. 1)" value={section.revNo} onChange={(e) => onChange({ ...section, revNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Effective Date (e.g. 09-Sep-2026)" value={section.effDate} onChange={(e) => onChange({ ...section, effDate: e.target.value })} />
```

The underlying field names (`formatNo`, `revNo`, `effDate`) are the dialect's own data keys, read by the backend renderer — do not rename them, only the placeholder text changes.

- [ ] **Step 2: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: rewrite Header section's document-control fields in plain language"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 7: Fill-out form — render Number and Dropdown columns

**Files:**
- Modify: `src/components/admin/GenericPdiSections.jsx`

This file is read by `GenericPdiGeneratorForm.jsx`, which was extensively hardened for autosave correctness earlier this session. This task must be **additive only** — new rendering branches inside the per-cell logic below — and must not touch `buildDefaultFormData`, `makeEmptyRow`, or anything about how `form`/autosave state is managed (none of that lives in this file; it's all in the parent component, which this task does not touch at all).

- [ ] **Step 1: Add Number/Dropdown rendering to `FixedTableSection` (Checklist)**

Replace:

```jsx
                  const value = (sectionData[row.key] && sectionData[row.key][c.cell.subfield]) || '';
                  const isSelect = ['GO', 'NG', 'NA'].includes(String(c.cell.default || '').toUpperCase());
                  return (
                    <td key={c.key} className="py-2 px-3 border border-gray-100 text-center">
                      {isSelect ? (
                        <div className="inline-flex rounded-md border border-gray-300 overflow-hidden" role="group" aria-label="GO/NG/NA result">
                          {['GO', 'NG', 'NA'].map((o) => {
                            const active = value === o;
                            const activeCls = o === 'GO' ? 'bg-green-600 text-white' : o === 'NG' ? 'bg-red-600 text-white' : 'bg-gray-500 text-white';
                            return (
                              <button
                                key={o}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setCell(section.dataKey, row.key, c.cell.subfield, o)}
                                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${active ? activeCls : 'bg-white text-gray-500 hover:bg-gray-50'} ${o !== 'GO' ? 'border-l border-gray-300' : ''}`}
                              >
                                {o}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <input className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)} />
                      )}
                    </td>
                  );
```

with:

```jsx
                  const value = (sectionData[row.key] && sectionData[row.key][c.cell.subfield]) || '';
                  const isSelect = ['GO', 'NG', 'NA'].includes(String(c.cell.default || '').toUpperCase());
                  return (
                    <td key={c.key} className="py-2 px-3 border border-gray-100 text-center">
                      {isSelect ? (
                        <div className="inline-flex rounded-md border border-gray-300 overflow-hidden" role="group" aria-label="GO/NG/NA result">
                          {['GO', 'NG', 'NA'].map((o) => {
                            const active = value === o;
                            const activeCls = o === 'GO' ? 'bg-green-600 text-white' : o === 'NG' ? 'bg-red-600 text-white' : 'bg-gray-500 text-white';
                            return (
                              <button
                                key={o}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setCell(section.dataKey, row.key, c.cell.subfield, o)}
                                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${active ? activeCls : 'bg-white text-gray-500 hover:bg-gray-50'} ${o !== 'GO' ? 'border-l border-gray-300' : ''}`}
                              >
                                {o}
                              </button>
                            );
                          })}
                        </div>
                      ) : c.format === 'dropdown' ? (
                        <select className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)}>
                          <option value="" disabled>Select…</option>
                          {(c.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      ) : (
                        <input
                          type={c.format === 'number' ? 'number' : 'text'}
                          className={INPUT_CLS}
                          value={value}
                          onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)}
                        />
                      )}
                    </td>
                  );
```

- [ ] **Step 2: Add Number/Dropdown rendering to `RepeatableTableSection` (Fill-in list)**

Replace:

```jsx
                {cols.map((c) => {
                  if (!c.cell || c.cell.source === 'row') {
                    return (
                      <td key={c.key} className="py-2 px-2 border border-gray-100">
                        <input className={INPUT_CLS} value={row[c.key] || ''} onChange={(e) => setCell(section.dataKey, idx, c.key, e.target.value)} />
                      </td>
                    );
                  }
```

with:

```jsx
                {cols.map((c) => {
                  if (!c.cell || c.cell.source === 'row') {
                    return (
                      <td key={c.key} className="py-2 px-2 border border-gray-100">
                        {c.format === 'dropdown' ? (
                          <select className={INPUT_CLS} value={row[c.key] || ''} onChange={(e) => setCell(section.dataKey, idx, c.key, e.target.value)}>
                            <option value="" disabled>Select…</option>
                            {(c.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                        ) : (
                          <input
                            type={c.format === 'number' ? 'number' : 'text'}
                            className={INPUT_CLS}
                            value={row[c.key] || ''}
                            onChange={(e) => setCell(section.dataKey, idx, c.key, e.target.value)}
                          />
                        )}
                      </td>
                    );
                  }
```

Leave the rest of that function (the `'constant'`-source branch immediately below) completely unchanged.

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/components/admin/GenericPdiSections.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Self-review — confirm no autosave-adjacent code was touched**

Run: `git diff src/components/admin/GenericPdiSections.jsx` and confirm the diff is scoped to exactly the two cell-rendering branches above — nothing in `buildDefaultFormData`, `makeEmptyRow`, or any export signature changed. This file has no autosave logic of its own (that lives entirely in `GenericPdiGeneratorForm.jsx`, which this task does not touch), so this check is about confirming the diff's shape matches what was intended, not about hunting for an unrelated regression.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/GenericPdiSections.jsx
git commit -m "feat: render Number and Dropdown column types in the PDI fill-out form"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 8: Orientation strip and typical-structure nudge

**Files:**
- Modify: `src/components/admin/PdiTemplatesAdminPage.jsx`

- [ ] **Step 1: Add the `missingTypicalSections` helper**

Add this module-level function directly above `TemplateEditor`:

```js
// A soft, non-blocking nudge -- never blocks Save or Publish, and
// disappears on its own once the condition it names is no longer true (no
// dismiss state to track). Checked across the WHOLE template (every page),
// not per-page, since a real PDI report's typical pieces (a header, at
// least one checklist, a signature) don't need to all live on one page.
function missingTypicalSections(definition) {
  const allSections = (definition.pages || []).flatMap((p) => p.sections || []);
  const missing = [];
  if (!allSections.some((s) => s.type === 'header')) missing.push('a Header');
  if (!allSections.some((s) => s.type === 'table' && s.mode === 'fixed')) missing.push('at least one Checklist');
  if (!allSections.some((s) => s.type === 'signature')) missing.push('Signatures');
  return missing;
}
```

- [ ] **Step 2: Add the orientation strip**

In `TemplateEditor`'s returned JSX, directly after the name/id/show-keys row (the `<div className="flex items-center gap-3">...</div>` block from Task 1), add:

```jsx
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2">
          Add sections to match your paper form. Changes save automatically and the preview updates on the right.
        </p>
```

- [ ] **Step 3: Add the typical-structure nudge**

Directly after the closing `))}` of the `definition.pages.map(...)` block and before the "Add page" button, add:

```jsx
          {missingTypicalSections(definition).length > 0 && (
            <p className="text-xs text-gray-400">
              Most PDI templates include {missingTypicalSections(definition).join(', ')}.
            </p>
          )}
```

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplatesAdminPage.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PdiTemplatesAdminPage.jsx
git commit -m "feat: add orientation strip and typical-structure nudge to the template editor"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 9: Section completeness indicators

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx`
- Modify: `src/components/admin/PdiTemplatesAdminPage.jsx`

- [ ] **Step 1: Add `sectionLooksFilledIn`**

In `src/components/admin/PdiTemplateSectionEditors.jsx`, add this export directly after `sectionCardTitle`:

```js
// Whether a section looks like it has real authored content yet — distinct
// from the fill-out form's own isSectionFilled check (which asks whether an
// INSPECTOR has entered data at fill time); this asks whether the ADMIN has
// put anything into the section while building the template.
export function sectionLooksFilledIn(section) {
  switch (section.type) {
    case 'header':
      return Boolean(section.companyName) || (section.infoFields || []).length > 0;
    case 'table':
      if (section.mode === 'fixed') return Boolean(section.title) && (section.fixedRows || []).length > 0;
      return Boolean(section.title) && (section.columns || []).length > 0;
    case 'photo':
      return section.mode === 'fixed-slots' ? (section.slots || []).length > 0 : Boolean(section.dataKey);
    case 'image':
      return Boolean(section.dataKey);
    case 'signature':
      return (section.roles || []).length > 0;
    case 'text':
      return Boolean(section.dataKey);
    default:
      return false;
  }
}
```

- [ ] **Step 2: Show a completeness dot on `SectionCard`**

In `src/components/admin/PdiTemplatesAdminPage.jsx`, add `sectionLooksFilledIn` to the import from `./PdiTemplateSectionEditors`:

```js
import {
  FIELD_CLS, ListEditor, AddSectionPicker, SectionEditorFor,
  sectionTypeOption, sectionCardTitle, ShowKeysContext, sectionLooksFilledIn,
} from './PdiTemplateSectionEditors';
```

In `SectionCard`, add the dot. Replace:

```jsx
function SectionCard({ section, onChange, definition }) {
  const [expanded, setExpanded] = useState(false);
  const typeOption = sectionTypeOption(section);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden w-full">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-medium text-gray-500 bg-gray-200 rounded px-1.5 py-0.5 shrink-0">{typeOption?.label || section.type}</span>
          <span className="text-sm font-medium text-gray-800 truncate">{sectionCardTitle(section)}</span>
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400 shrink-0" /> : <ChevronDown size={16} className="text-gray-400 shrink-0" />}
      </button>
```

with:

```jsx
function SectionCard({ section, onChange, definition }) {
  const [expanded, setExpanded] = useState(false);
  const typeOption = sectionTypeOption(section);
  const filledIn = sectionLooksFilledIn(section);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden w-full">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${filledIn ? 'bg-green-500' : 'bg-gray-300'}`}
            title={filledIn ? 'Has content' : 'Still empty'}
          />
          <span className="text-[10px] font-medium text-gray-500 bg-gray-200 rounded px-1.5 py-0.5 shrink-0">{typeOption?.label || section.type}</span>
          <span className="text-sm font-medium text-gray-800 truncate">{sectionCardTitle(section)}</span>
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400 shrink-0" /> : <ChevronDown size={16} className="text-gray-400 shrink-0" />}
      </button>
```

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx src/components/admin/PdiTemplatesAdminPage.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx src/components/admin/PdiTemplatesAdminPage.jsx
git commit -m "feat: add per-section completeness indicators to the collapsed section cards"
```

Commit message must end with:
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

---

### Task 10: Controller-personal live verification

**Do this task yourself, in the main session — not via a dispatched subagent.** This repo's dev backend connects to the same production RDS database as `intute.biz` (no separate staging DB) — follow the same discipline used in every previous live-verification pass this session: create clearly-named throwaway test data, delete every bit of it afterward, and if `CRM_BACKEND/.env`'s `FRONTEND_URL` needs to be temporarily pointed at `http://localhost:5173` to test against the local backend, capture its exact original bytes first and restore them byte-for-byte when done (including restarting the backend process so its live config matches the restored file).

- [ ] **Step 1: Start both dev servers, log in**

- [ ] **Step 2: Global key toggle** — open any existing template, toggle "Show technical keys" on, confirm every field across every section type reveals its key inline with no per-field "Advanced" links remaining anywhere; toggle off, confirm they all disappear together.

- [ ] **Step 3: Duplicate** — duplicate an existing template, confirm the copy opens pre-filled with every section/field from the source; duplicate the SAME template a second time immediately after, confirm the silent `-2`-suffix retry succeeds without an error. Confirm "+ Start a blank template from scratch" still creates an empty template when used.

- [ ] **Step 4: Picker previews** — open "+ Add section", confirm all 7 options show an icon and a concrete example (not the old one-line abstract description).

- [ ] **Step 5: Checklist flexible columns** — build a Checklist with two items; in its Columns list, add a Fixed-value column (e.g. "Specified" = "Go/NG") and a Text column (e.g. "Remarks"); drag the Result column so it sits after "Specified" but before "Remarks" (matching the real "General" template's own layout); confirm Item and Result both show "can't remove" and have no delete icon, but both are still draggable; confirm the live preview renders all four columns correctly.

- [ ] **Step 6: Fill-in list column types** — build a Fill-in list with a Number column and a Dropdown column (define 2-3 options); confirm the live preview renders sample rows with those columns.

- [ ] **Step 7: Orientation, nudge, completeness** — confirm the orientation strip is always visible; on a template missing a Header/Checklist/Signatures, confirm the nudge names exactly what's missing, and confirm it disappears once you add the missing piece(s); confirm each collapsed section card's dot is grey when the section is empty and turns colored once it has real content (title + at least one row/column/etc., matching Task 9's per-type rules).

- [ ] **Step 8: Fill-out round trip** — publish the test template, fill it out through the (already-hardened) PDI Generator form: confirm the Checklist's new Fixed/Text columns render and save correctly, confirm the Fill-in list's Number input only accepts numeric entry and the Dropdown renders your defined options, confirm autosave ("All changes saved") still behaves correctly throughout (no regression from Task 7's changes), finalize, and confirm the generated PDF renders every new column's value correctly. Use the PowerShell + `Windows.Data.Pdf` WinRT technique from earlier this session (`powershell.exe`, not `pwsh`) to render the PDF to PNG if a direct visual check is needed, since headless Chromium won't show PDF content in a screenshot.

- [ ] **Step 9: Clean up and report status**

Delete every test template and report created during this pass. Revert `CRM_BACKEND/.env` to its exact original bytes if it was changed, and restart the backend so its live process matches. Report DONE if everything in Steps 2–8 passed; if anything failed, fix it directly (this step is personal, not delegated), re-verify, then report DONE.
