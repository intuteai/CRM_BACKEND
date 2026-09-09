# PDI Template Authoring UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the PDI template authoring page so a non-technical admin never sees the dialect's own internal vocabulary (`dataKey`, `source`, `subfield`) — labels auto-generate keys, table sections become two purpose-built editors instead of one generic columns-editor, sections are collapsible/drag-reorderable cards, and a live PDF preview sits beside the editor instead of behind a button.

**Architecture:** Same route, same top-level component, zero backend changes — every save/publish/archive/preview call still goes through the existing, unmodified admin API. The 544-line `PdiTemplatesAdminPage.jsx` splits into a small shared slug utility, a new file holding every per-section-type editor plus the shared list/drag infrastructure, a new live-preview-pane component, and the trimmed original file (list view, creation form, `TemplateEditor` orchestration).

**Tech Stack:** React (hooks), Tailwind CSS, lucide-react icons, native HTML5 drag-and-drop (no new dependency — this codebase has none today).

**Spec:** `docs/superpowers/specs/2026-09-09-pdi-template-authoring-ux-redesign-design.md`

---

## Before you start: two constraints that are easy to get wrong

**1. The Checklist editor's GO/NG/NA result column is NOT configurable.** An early brainstorm mockup showed a "+ edit options" affordance next to the result options — that idea was explicitly rejected during design, not merely left out. The reason: `renderer.js` and `GenericPdiSections.jsx`'s `FixedTableSection` both hard-code recognition of exactly `['GO','NG','NA']` (case-insensitive) to decide whether to draw a 3-way toggle at all; a template with different option labels would silently fall back to a plain text box downstream with no toggle. Task 3 below generates the exact same two-column definition every time, with no UI to change it. Do not add an "edit options" control even though it seems like an obvious enhancement — it would silently produce templates that render differently than the editor implies.

**2. `dataKey`s must stay unique across the WHOLE template, not just within one section.** Every section's fields land in one flattened `data` object at fill-time (see `buildDefaultFormData` in `CRM/src/components/admin/GenericPdiSections.jsx` for the exact flattening this mirrors on the fill-out side). Task 2's `collectAllKeys`/`labelToKey` plumbing exists specifically to catch collisions across section and page boundaries, not just within the field currently being typed into.

---

### Task 1: `pdiTemplateSlug.js` — the shared slugify/dedupe utility

**Files:**
- Create: `src/utils/pdiTemplateSlug.js`

This is a small, pure, dependency-free module — no React, no fetch. Everything else in this plan depends on it, so get it exactly right before moving on.

- [ ] **Step 1: Write the module**

Create `src/utils/pdiTemplateSlug.js`:

```js
// CRM/src/utils/pdiTemplateSlug.js
//
// Converts a plain-language label into the snake_case key style already
// used throughout this project's own hand-authored templates and dialect
// (customer_name, pdi_no, motor_sr_no, ...), and guarantees uniqueness
// against a set of keys already in use elsewhere. Shared between template-id
// generation (the creation form) and every field-key generation inside the
// section editors — see docs/superpowers/specs/2026-09-09-pdi-template-authoring-ux-redesign-design.md.

// lowercase, collapse any run of whitespace/non-alphanumeric characters into
// a single underscore, strip leading/trailing underscores. An empty or
// all-punctuation label correctly produces an empty string — callers should
// treat that as "no key yet" (matching a field the admin hasn't labeled yet),
// not as an error.
export function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Given a candidate key and the set of keys already used elsewhere, returns
// the candidate unchanged if it's free, or candidate_2, candidate_3, ...
// (first free suffix) if it collides. An empty candidate is returned
// unchanged (never suffixed) — see slugify's own note above.
export function dedupeKey(candidate, usedKeys) {
  if (!candidate) return candidate;
  const used = usedKeys instanceof Set ? usedKeys : new Set(usedKeys);
  if (!used.has(candidate)) return candidate;
  let n = 2;
  while (used.has(`${candidate}_${n}`)) n += 1;
  return `${candidate}_${n}`;
}

// Convenience: slugify then dedupe in one call — the common case everywhere
// this is used ("turn this label into a guaranteed-unique key").
export function labelToKey(label, usedKeys) {
  return dedupeKey(slugify(label), usedKeys);
}
```

- [ ] **Step 2: Verify with a throwaway script (this repo has no test runner — see the note below)**

This frontend has no `test` script in `package.json` and no Jest/Vitest configured — confirmed earlier in this project. Verify with a plain Node script instead, matching how other pure-JS pieces were spot-checked earlier in this same project.

Create a scratch file (anywhere outside `src/`, e.g. your working directory, not committed) `verify-slug.mjs`:

```js
import { slugify, dedupeKey, labelToKey } from './src/utils/pdiTemplateSlug.js';
import assert from 'node:assert';

assert.strictEqual(slugify('Customer Name'), 'customer_name');
assert.strictEqual(slugify('PDI No.'), 'pdi_no');
assert.strictEqual(slugify('  Motor Sr.No  '), 'motor_sr_no');
assert.strictEqual(slugify(''), '');
assert.strictEqual(slugify('   ...   '), '');
assert.strictEqual(slugify('Already_snake_case'), 'already_snake_case');

assert.strictEqual(dedupeKey('customer_name', []), 'customer_name');
assert.strictEqual(dedupeKey('customer_name', ['customer_name']), 'customer_name_2');
assert.strictEqual(dedupeKey('customer_name', ['customer_name', 'customer_name_2']), 'customer_name_3');
assert.strictEqual(dedupeKey('', ['']), ''); // empty candidate never gets suffixed

assert.strictEqual(labelToKey('Customer Name', new Set()), 'customer_name');
assert.strictEqual(labelToKey('Customer Name', new Set(['customer_name'])), 'customer_name_2');

console.log('All pdiTemplateSlug checks passed.');
```

Run: `node verify-slug.mjs` (run from the `CRM` repo root so the relative import resolves)
Expected: `All pdiTemplateSlug checks passed.` with no errors.

Delete `verify-slug.mjs` afterward — it's a one-off verification script, not part of the shipped code.

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/utils/pdiTemplateSlug.js`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully (this file isn't imported anywhere yet, so the build succeeding just confirms no syntax errors).

- [ ] **Step 4: Commit**

```bash
git add src/utils/pdiTemplateSlug.js
git commit -m "feat: add slugify/dedupe utility for PDI template authoring"
```

---

### Task 2: `PdiTemplateSectionEditors.jsx` — shared infrastructure and the simple editors

**Files:**
- Create: `src/components/admin/PdiTemplateSectionEditors.jsx`

This task creates the new file with: the drag-and-drop-capable `ListEditor`, the `collectAllKeys` definition-walker, the `LabeledKeyField` auto-key input, and the five section editors that only need mechanical simplification (`HeaderSectionEditor`, `PhotoSectionEditor`, `ImageSectionEditor`, `SignatureSectionEditor`, `NotesSectionEditor`). The two new table editors (`ChecklistSectionEditor`, `FillInListSectionEditor`) and the section-type picker are Task 3, added to this same file — this task lays the foundation they both depend on.

- [ ] **Step 1: Write the file's shared infrastructure and simple editors**

Create `src/components/admin/PdiTemplateSectionEditors.jsx`:

```jsx
// CRM/src/components/admin/PdiTemplateSectionEditors.jsx
import { useState } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { labelToKey } from '../../utils/pdiTemplateSlug';

export const FIELD_CLS = 'border border-gray-300 rounded px-2 py-1 text-sm w-full';

// Walks a template definition and collects every dataKey/key currently in
// use, across every page and section — dataKeys must be unique across the
// WHOLE template (they all land in one flattened `data` object at fill
// time), not just within the section currently being edited. See the
// "Before you start" note at the top of the plan this function belongs to.
export function collectAllKeys(definition) {
  const keys = new Set();
  (definition.pages || []).forEach((page) => {
    (page.sections || []).forEach((section) => {
      if (section.type === 'header') {
        (section.infoFields || []).forEach((f) => {
          if (f.leftKey) keys.add(f.leftKey);
          if (f.rightKey) keys.add(f.rightKey);
        });
      } else if (section.type === 'table') {
        if (section.dataKey) keys.add(section.dataKey);
        (section.columns || []).forEach((c) => { if (c.key) keys.add(c.key); });
        (section.fixedRows || []).forEach((r) => { if (r.key) keys.add(r.key); });
      } else if (section.type === 'photo') {
        if (section.dataKey) keys.add(section.dataKey);
        (section.slots || []).forEach((s) => { if (s.key) keys.add(s.key); });
      } else if (section.type === 'image' || section.type === 'text') {
        if (section.dataKey) keys.add(section.dataKey);
      } else if (section.type === 'signature') {
        (section.roles || []).forEach((r) => { if (r.key) keys.add(r.key); });
      }
    });
  });
  return keys;
}

// A plain-language label input with its derived key auto-generated and
// hidden behind a small "Advanced" toggle — the pattern used everywhere a
// field used to need a hand-typed dataKey. `usedKeysExcludingSelf` must
// already have this field's OWN current key removed by the caller (via
// collectAllKeys(...) minus the one key this field owns), or renaming a
// field would immediately "collide" with its own old key and get a
// spurious _2 suffix. `onChange` is called with `{ label, key }`.
export function LabeledKeyField({ label, keyValue, usedKeysExcludingSelf, onChange, placeholder }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        className="text-[11px] text-gray-400 hover:text-gray-600 mt-0.5"
      >
        {showAdvanced ? 'Hide key' : 'Advanced'}
      </button>
      {showAdvanced && (
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

function moveNoop() {} // placeholder retained for readability of the diff below — remove if unused after Step 1

// ── Small reusable list-editor: add/remove/drag-reorder rows of a fixed shape ──
// Reordering only commits on drop, not on every dragover — this keeps the
// underlying `items` array (and therefore each row's key={i}-based DOM
// identity) stable for the full duration of a drag gesture, avoiding the
// index-key/DOM-recycling jank that a live-reorder-during-drag approach
// would risk (React reassigning the dragged browser element to a different
// logical row mid-gesture).
export function ListEditor({ items, onChange, renderRow, newRow, addLabel }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const handleDrop = (dropIndex) => (e) => {
    e.preventDefault();
    setOverIndex(null);
    if (dragIndex === null || dragIndex === dropIndex) { setDragIndex(null); return; }
    const reordered = [...items];
    const [moved] = reordered.splice(dragIndex, 1);
    const insertAt = dragIndex < dropIndex ? dropIndex - 1 : dropIndex;
    reordered.splice(insertAt, 0, moved);
    onChange(reordered);
    setDragIndex(null);
  };

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
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
          <button type="button" onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="text-red-500 hover:text-red-700 shrink-0">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, newRow()])}
        className="flex items-center gap-1 text-xs font-medium text-amber-700 border border-amber-300 rounded px-2 py-1 hover:bg-amber-50"
      >
        <Plus size={14} /> {addLabel}
      </button>
    </div>
  );
}

// Deliberately doesn't expose logoAsset or extraFormatLines — both are rare
// fields (only the hand-coded General/AutoNXT templates have ever needed a
// logo or a 4th format-box line); a template authored through this UI simply
// can't set them yet. Accepted v1 scope limit, carried over unchanged from
// before this redesign.
export function HeaderSectionEditor({ section, onChange, definition }) {
  const ownKeys = new Set();
  (section.infoFields || []).forEach((f) => { if (f.leftKey) ownKeys.add(f.leftKey); if (f.rightKey) ownKeys.add(f.rightKey); });
  const otherKeys = collectAllKeys(definition);
  ownKeys.forEach((k) => otherKeys.delete(k));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input className={FIELD_CLS} placeholder="Company name" value={section.companyName} onChange={(e) => onChange({ ...section, companyName: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Format No." value={section.formatNo} onChange={(e) => onChange({ ...section, formatNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Rev No." value={section.revNo} onChange={(e) => onChange({ ...section, revNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Eff. Date" value={section.effDate} onChange={(e) => onChange({ ...section, effDate: e.target.value })} />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600">Detail rows (shown at the top of the page, e.g. Customer / Date)</label>
        <ListEditor
          items={section.infoFields}
          onChange={(infoFields) => onChange({ ...section, infoFields })}
          addLabel="Add detail row"
          newRow={() => ({ leftLabel: '', leftKey: '', leftFormat: 'text', rightLabel: '', rightKey: '', rightFormat: 'text' })}
          renderRow={(row, update) => {
            const excludingThisRow = new Set(otherKeys);
            [row.leftKey, row.rightKey].forEach((k) => { if (k) excludingThisRow.delete(k); });
            return (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="flex gap-1 items-start">
                  <div className="flex-1">
                    <LabeledKeyField
                      label={row.leftLabel}
                      keyValue={row.leftKey}
                      usedKeysExcludingSelf={excludingThisRow}
                      placeholder="e.g. Customer Name"
                      onChange={({ label, key }) => update({ ...row, leftLabel: label, leftKey: key })}
                    />
                  </div>
                  <select className={FIELD_CLS + ' w-20'} value={row.leftFormat} onChange={(e) => update({ ...row, leftFormat: e.target.value })}>
                    <option value="text">text</option><option value="date">date</option>
                  </select>
                </div>
                <div className="flex gap-1 items-start">
                  <div className="flex-1">
                    <LabeledKeyField
                      label={row.rightLabel}
                      keyValue={row.rightKey}
                      usedKeysExcludingSelf={excludingThisRow}
                      placeholder="e.g. Date"
                      onChange={({ label, key }) => update({ ...row, rightLabel: label, rightKey: key })}
                    />
                  </div>
                  <select className={FIELD_CLS + ' w-20'} value={row.rightFormat} onChange={(e) => update({ ...row, rightFormat: e.target.value })}>
                    <option value="text">text</option><option value="date">date</option>
                  </select>
                </div>
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}

export function PhotoSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);
  (section.slots || []).forEach((s) => { if (s.key) excludingThisSection.delete(s.key); });

  return (
    <div className="space-y-2">
      <select className={FIELD_CLS} value={section.mode} onChange={(e) => onChange({ ...section, mode: e.target.value })}>
        <option value="freeform">Inspector adds their own photos</option>
        <option value="fixed-slots">Fixed photo slots (you name each one)</option>
      </select>
      {section.mode === 'fixed-slots' ? (
        <ListEditor
          items={section.slots}
          onChange={(slots) => onChange({ ...section, slots })}
          addLabel="Add photo slot"
          newRow={() => ({ key: '', label: '' })}
          renderRow={(slot, update) => {
            const excludingThisSlot = new Set(excludingThisSection);
            (section.slots || []).forEach((s) => { if (s.key && s.key !== slot.key) excludingThisSlot.delete(s.key); });
            return (
              <LabeledKeyField
                label={slot.label}
                keyValue={slot.key}
                usedKeysExcludingSelf={excludingThisSlot}
                placeholder="e.g. Nameplate Photo"
                onChange={({ label, key }) => update({ label, key })}
              />
            );
          }}
        />
      ) : (
        <LabeledKeyField
          label={section.label || ''}
          keyValue={section.dataKey}
          usedKeysExcludingSelf={excludingThisSection}
          placeholder="e.g. Inspection Photos"
          onChange={({ label, key }) => onChange({ ...section, label, dataKey: key })}
        />
      )}
    </div>
  );
}

// Deliberately doesn't expose `width` (defaults to full content width via
// the backend's `section.width || CW` fallback) — same rare-field reasoning
// as HeaderSectionEditor's logoAsset/extraFormatLines above.
export function ImageSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);

  return (
    <div className="space-y-2">
      <LabeledKeyField
        label={section.title || ''}
        keyValue={section.dataKey}
        usedKeysExcludingSelf={excludingThisSection}
        placeholder="e.g. Nameplate"
        onChange={({ label, key }) => onChange({ ...section, title: label, dataKey: key })}
      />
      <input className={FIELD_CLS} type="number" placeholder="Height" value={section.height} onChange={(e) => onChange({ ...section, height: Number(e.target.value) })} />
      <input
        className={FIELD_CLS}
        placeholder="Placeholder text (shown when no image supplied)"
        value={section.placeholder?.text || ''}
        onChange={(e) => onChange({ ...section, placeholder: e.target.value ? { text: e.target.value, annotations: section.placeholder?.annotations || [] } : null })}
      />
    </div>
  );
}

export function SignatureSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  (section.roles || []).forEach((r) => { if (r.key) excludingThisSection.delete(r.key); });

  return (
    <ListEditor
      items={section.roles}
      onChange={(roles) => onChange({ ...section, roles })}
      addLabel="Add signer"
      newRow={() => ({ key: '', label: '' })}
      renderRow={(role, update) => {
        const excludingThisRole = new Set(excludingThisSection);
        (section.roles || []).forEach((r) => { if (r.key && r.key !== role.key) excludingThisRole.delete(r.key); });
        return (
          <LabeledKeyField
            label={role.label}
            keyValue={role.key}
            usedKeysExcludingSelf={excludingThisRole}
            placeholder="e.g. Inspected By"
            onChange={({ label, key }) => update({ label, key })}
          />
        );
      }}
    />
  );
}

export function NotesSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);

  return (
    <div className="space-y-2">
      <LabeledKeyField
        label={section.label}
        keyValue={section.dataKey}
        usedKeysExcludingSelf={excludingThisSection}
        placeholder="e.g. Remarks"
        onChange={({ label, key }) => onChange({ ...section, label, dataKey: key })}
      />
      <input className={FIELD_CLS} placeholder="Default text (optional)" value={section.default || ''} onChange={(e) => onChange({ ...section, default: e.target.value })} />
    </div>
  );
}
```

Remove the placeholder `function moveNoop() {}` line — it was left in the listing above only to make the diff boundary between "infrastructure" and "the rest of the file" easy to spot while writing this plan; it must not appear in the actual committed file.

- [ ] **Step 2: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors. (`ChecklistSectionEditor`/`FillInListSectionEditor`/the section-type picker don't exist yet — that's Task 3 — so nothing in this file references them yet.)

Run: `npm run build`
Expected: builds successfully (this file isn't imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: add PDI template editor infrastructure (drag-and-drop list, auto-key fields) and simple section editors"
```

---

### Task 3: Add the Checklist and Fill-in list editors, and the section-type picker

**Files:**
- Modify: `src/components/admin/PdiTemplateSectionEditors.jsx` (append to the file Task 2 created)

- [ ] **Step 1: Add `ChecklistSectionEditor`**

Add to `src/components/admin/PdiTemplateSectionEditors.jsx`, after `NotesSectionEditor`:

```jsx
// Produces { type: 'table', mode: 'fixed', ... }. The result column is
// ALWAYS exactly GO/NG/NA — see the "Before you start" note at the top of
// this plan for why that's not configurable here, no matter how natural an
// "edit options" control might seem.
export function ChecklistSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);
  (section.fixedRows || []).forEach((r) => { if (r.key) excludingThisSection.delete(r.key); });

  const columns = [
    { key: 'item', label: 'Item', cell: { source: 'row' } },
    { key: 'result', label: 'Result', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } },
  ];

  return (
    <div className="space-y-2">
      <LabeledKeyField
        label={section.title || ''}
        keyValue={section.dataKey}
        usedKeysExcludingSelf={excludingThisSection}
        placeholder="e.g. Winding & Bearing Checks"
        onChange={({ label, key }) => onChange({ ...section, title: label, dataKey: key, columns })}
      />
      <p className="text-[11px] text-gray-400">Every item is marked GO / NG / NA by the inspector — this isn't customizable.</p>
      <ListEditor
        items={section.fixedRows || []}
        onChange={(fixedRows) => onChange({ ...section, columns, fixedRows })}
        addLabel="Add checklist item"
        newRow={() => ({ key: '', item: '' })}
        renderRow={(row, update) => {
          const excludingThisRow = new Set(excludingThisSection);
          (section.fixedRows || []).forEach((r) => { if (r.key && r.key !== row.key) excludingThisRow.delete(r.key); });
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
  );
}
```

Note: `row.item` here is a display-only convenience for the editor (it's what `LabeledKeyField` shows as the "label") — the actual dialect only needs `row.key`; the fixed row's `item` property isn't part of the rendering contract (per `authoredTemplate.js`, a fixed row only needs its `key` to match `columns[].cell.subfield`'s lookup) and is harmless to carry along in the definition JSON as extra data. Do not strip it before saving — leaving it is simpler than special-casing its removal, and it does no harm (the PDF renderer only reads `row[c.key]` for `source: 'row'` columns, which this editor's checklist rows don't have, and `row.key` for the `sectionData` lookup).

- [ ] **Step 2: Add `FillInListSectionEditor`**

Add to the same file, after `ChecklistSectionEditor`:

```jsx
// Produces { type: 'table', mode: 'repeatable', ... }. Every column defaults
// to { source: 'row' } (the inspector types a value per row) — the rare
// "always show this value" case is available per-column under Advanced.
export function FillInListSectionEditor({ section, onChange, definition }) {
  const excludingThisSection = new Set(collectAllKeys(definition));
  if (section.dataKey) excludingThisSection.delete(section.dataKey);
  (section.columns || []).forEach((c) => { if (c.key) excludingThisSection.delete(c.key); });

  return (
    <div className="space-y-2">
      <LabeledKeyField
        label={section.title || ''}
        keyValue={section.dataKey}
        usedKeysExcludingSelf={excludingThisSection}
        placeholder="e.g. Motor Serial Numbers"
        onChange={({ label, key }) => onChange({ ...section, title: label, dataKey: key })}
      />
      <ListEditor
        items={section.columns || []}
        onChange={(columns) => {
          // If the column that was providing filterKey got removed, drop it too.
          const stillHasFilterCol = columns.some((c) => c.key === section.filterKey);
          onChange({ ...section, columns, filterKey: stillHasFilterCol ? section.filterKey : undefined });
        }}
        addLabel="Add column"
        newRow={() => ({ key: '', label: '', cell: { source: 'row' } })}
        renderRow={(col, update) => {
          const excludingThisCol = new Set(excludingThisSection);
          (section.columns || []).forEach((c) => { if (c.key && c.key !== col.key) excludingThisCol.delete(c.key); });
          const [showAdvanced, setShowAdvanced] = useState(false);
          const isConstant = col.cell?.source === 'constant';
          const isFilterCol = section.filterKey === col.key;
          return (
            <div className="space-y-1">
              <LabeledKeyField
                label={col.label}
                keyValue={col.key}
                usedKeysExcludingSelf={excludingThisCol}
                placeholder="e.g. Motor Sr.No"
                onChange={({ label, key }) => {
                  const patch = { label, key };
                  // Renaming the key this table's filterKey points at must
                  // keep the reference correct, not silently orphan it.
                  if (col.key && section.filterKey === col.key) {
                    onChange({ ...section, filterKey: key });
                  }
                  update({ ...col, ...patch });
                }}
              />
              <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-[11px] text-gray-400 hover:text-gray-600">
                {showAdvanced ? 'Hide advanced' : 'Advanced'}
              </button>
              {showAdvanced && (
                <div className="space-y-1 pl-2 border-l-2 border-gray-100">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={isConstant}
                      onChange={(e) => update({ ...col, cell: e.target.checked ? { source: 'constant', value: '' } : { source: 'row' } })}
                    />
                    Always show this value
                  </label>
                  {isConstant && (
                    <input
                      className={FIELD_CLS}
                      placeholder="Value shown in every row"
                      value={col.cell.value}
                      onChange={(e) => update({ ...col, cell: { source: 'constant', value: e.target.value } })}
                    />
                  )}
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={isFilterCol}
                      onChange={(e) => onChange({ ...section, filterKey: e.target.checked ? col.key : undefined })}
                    />
                    Skip empty rows in this column
                  </label>
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
```

Note the `useState` call inside `renderRow`'s callback: `ListEditor` calls `renderRow(item, update)` as a plain function during render, not as a nested component — calling a hook inside it violates the Rules of Hooks (a fresh `useState` would be created honoring call-order only if the number/order of rows never changes between renders, which isn't guaranteed here since rows can be added/removed/reordered). **Do not ship this as written above.** Instead, extract the per-column advanced-toggle UI into its own small named component so the hook has a stable component boundary to attach to:

```jsx
function FillInListColumnRow({ col, section, excludingThisCol, update, onSectionChange }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isConstant = col.cell?.source === 'constant';
  const isFilterCol = section.filterKey === col.key;
  return (
    <div className="space-y-1">
      <LabeledKeyField
        label={col.label}
        keyValue={col.key}
        usedKeysExcludingSelf={excludingThisCol}
        placeholder="e.g. Motor Sr.No"
        onChange={({ label, key }) => {
          if (col.key && section.filterKey === col.key) {
            onSectionChange({ ...section, filterKey: key });
          }
          update({ ...col, label, key });
        }}
      />
      <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-[11px] text-gray-400 hover:text-gray-600">
        {showAdvanced ? 'Hide advanced' : 'Advanced'}
      </button>
      {showAdvanced && (
        <div className="space-y-1 pl-2 border-l-2 border-gray-100">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={isConstant}
              onChange={(e) => update({ ...col, cell: e.target.checked ? { source: 'constant', value: '' } : { source: 'row' } })}
            />
            Always show this value
          </label>
          {isConstant && (
            <input
              className={FIELD_CLS}
              placeholder="Value shown in every row"
              value={col.cell.value}
              onChange={(e) => update({ ...col, cell: { source: 'constant', value: e.target.value } })}
            />
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={isFilterCol}
              onChange={(e) => onSectionChange({ ...section, filterKey: e.target.checked ? col.key : undefined })}
            />
            Skip empty rows in this column
          </label>
        </div>
      )}
    </div>
  );
}
```

And `FillInListSectionEditor`'s `renderRow` becomes a thin wrapper that just renders `<FillInListColumnRow>`:

```jsx
        renderRow={(col, update) => {
          const excludingThisCol = new Set(excludingThisSection);
          (section.columns || []).forEach((c) => { if (c.key && c.key !== col.key) excludingThisCol.delete(c.key); });
          return (
            <FillInListColumnRow
              col={col}
              section={section}
              excludingThisCol={excludingThisCol}
              update={update}
              onSectionChange={onChange}
            />
          );
        }}
```

Place `FillInListColumnRow`'s definition directly above `FillInListSectionEditor` in the file (a plain, un-exported helper component, same visibility level as the rest of this file's internals).

- [ ] **Step 3: Add the section-type picker and the dispatcher**

Add to the same file, after `FillInListSectionEditor`:

```jsx
// Replaces the old bare <select> of raw type names. Each option's `build`
// creates a brand-new, empty section of that type — used only when adding a
// NEW section; there is no in-place "change an existing section's type"
// control anymore (see the spec: switching types always discarded whatever
// was configured anyway, so removing the illusion of an in-place change and
// requiring delete-then-re-add isn't a capability loss).
export const SECTION_TYPE_OPTIONS = [
  { value: 'header', label: 'Header', description: 'Company details and top-of-page info like customer/date', build: () => ({ type: 'header', companyName: '', formatNo: '', revNo: '', effDate: '', extraFormatLines: [], logoAsset: null, infoFields: [] }) },
  { value: 'checklist', label: 'Checklist', description: 'A fixed list of items the inspector marks GO/NG/NA', build: () => ({ type: 'table', mode: 'fixed', title: '', dataKey: '', columns: [], headerHeight: 20, rowHeight: 14, fixedRows: [] }) },
  { value: 'fillInList', label: 'Fill-in list', description: 'A list the inspector adds rows to, like serial numbers', build: () => ({ type: 'table', mode: 'repeatable', title: '', dataKey: '', columns: [], headerHeight: 20, rowHeight: 14, filterKey: undefined }) },
  { value: 'photo', label: 'Photos', description: 'Space for the inspector to attach photos', build: () => ({ type: 'photo', mode: 'freeform', dataKey: '', label: '', slots: [] }) },
  { value: 'image', label: 'Image', description: 'A single fixed image, like a nameplate', build: () => ({ type: 'image', dataKey: '', width: null, height: 100, title: '', placeholder: null }) },
  { value: 'signature', label: 'Signatures', description: 'Sign-off name fields', build: () => ({ type: 'signature', roles: [] }) },
  { value: 'notes', label: 'Notes', description: 'A free-text remarks box', build: () => ({ type: 'text', label: '', dataKey: '', default: '' }) },
];

// A section's displayed type-badge/name in the picker and on its collapsed
// card — distinguishes 'table'+'fixed' (Checklist) from 'table'+'repeatable'
// (Fill-in list), which share one dialect `type` but are different editors.
export function sectionTypeOption(section) {
  if (section.type === 'table') {
    return SECTION_TYPE_OPTIONS.find((o) => o.value === (section.mode === 'fixed' ? 'checklist' : 'fillInList'));
  }
  const byType = { header: 'header', photo: 'photo', image: 'image', signature: 'signature', text: 'notes' };
  return SECTION_TYPE_OPTIONS.find((o) => o.value === byType[section.type]);
}

// A short, human name for a section's collapsed card — falls back to the
// plain type name (via sectionTypeOption) when the section has no title/
// label of its own yet (header/photo/signature never do; table/image/text
// do once the admin has typed one).
export function sectionCardTitle(section) {
  return section.title || section.label || sectionTypeOption(section)?.label || 'Section';
}

export function AddSectionPicker({ onAdd }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full border-2 border-dashed border-gray-300 rounded-lg py-3 text-sm text-gray-400 hover:border-amber-300 hover:text-amber-600 transition-colors"
      >
        + Add section
      </button>
    );
  }
  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-1">
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
      <button type="button" onClick={() => setOpen(false)} className="w-full text-center text-xs text-gray-400 pt-1">
        Cancel
      </button>
    </div>
  );
}

// Dispatches a section to its editor by dialect shape (table further
// dispatches by mode) — the single place that maps a section's data shape
// to the component that edits it.
export function SectionEditorFor({ section, onChange, definition }) {
  if (section.type === 'header') return <HeaderSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'table' && section.mode === 'fixed') return <ChecklistSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'table') return <FillInListSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'photo') return <PhotoSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'image') return <ImageSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'signature') return <SignatureSectionEditor section={section} onChange={onChange} definition={definition} />;
  if (section.type === 'text') return <NotesSectionEditor section={section} onChange={onChange} definition={definition} />;
  return null;
}
```

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors — in particular, no `react-hooks/rules-of-hooks` error, which is exactly what Step 2's `FillInListColumnRow` extraction exists to avoid. If you see that error, it means the extraction wasn't applied and `useState` is still being called from inside a plain callback — fix by re-reading Step 2, don't suppress the lint rule.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: add Checklist/Fill-in-list table editors and the section-type picker"
```

---

### Task 4: `PdiTemplatePreviewPane.jsx` — the live preview pane

**Files:**
- Create: `src/components/admin/PdiTemplatePreviewPane.jsx`

- [ ] **Step 1: Write the component**

Create `src/components/admin/PdiTemplatePreviewPane.jsx`:

```jsx
// CRM/src/components/admin/PdiTemplatePreviewPane.jsx
import { useEffect, useRef, useState } from 'react';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Debounced live preview: POSTs the current definition to the EXISTING,
// unmodified /preview endpoint (the same one today's "Preview PDF" button
// already calls) and renders the returned PDF inline via an iframe pointed
// at a blob URL. A definition that's mid-edit and therefore invalid 400s
// from the backend's own existing validation — shown as a small inline
// notice, without clearing whatever was last successfully rendered, so the
// pane doesn't go blank on every single invalid keystroke.
export default function PdiTemplatePreviewPane({ templateId, definition }) {
  const [pdfUrl, setPdfUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const currentUrlRef = useRef(null);
  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const thisRequestId = ++requestIdRef.current;
      setLoading(true);
      try {
        const res = await fetch(`${BASE_URL}/api/pdi/admin/templates/${templateId}/preview`, {
          method: 'POST', headers: authHeaders(), body: JSON.stringify({ definition }),
        });
        // A slower-than-expected earlier request landing after a newer one
        // must not clobber the newer result — only the most recent request
        // this effect has fired is allowed to update state.
        if (thisRequestId !== requestIdRef.current) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || 'Could not render a preview.');
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = url;
        setPdfUrl(url);
        setError(null);
      } catch {
        if (thisRequestId === requestIdRef.current) setError('Could not reach the server to render a preview.');
      } finally {
        if (thisRequestId === requestIdRef.current) setLoading(false);
      }
    }, 800);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(definition), templateId]);

  useEffect(() => {
    return () => { if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current); };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 flex items-center justify-between shrink-0">
        <span>Live Preview</span>
        {loading && <span className="normal-case text-gray-400">Updating…</span>}
      </div>
      {error && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2 shrink-0">
          Can't preview — {error}
        </div>
      )}
      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden">
        {pdfUrl ? (
          <iframe src={pdfUrl} title="Template preview" className="w-full h-full" />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400 p-4 text-center">
            {error ? 'Add a section to see a preview.' : 'Preview will appear here once the template has at least one section.'}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplatePreviewPane.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully (not imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/PdiTemplatePreviewPane.jsx
git commit -m "feat: add live PDF preview pane for PDI template authoring"
```

---

### Task 5: Rewire `PdiTemplatesAdminPage.jsx`

**Files:**
- Modify: `src/components/admin/PdiTemplatesAdminPage.jsx`

This task: (a) removes everything Task 2/3 moved out (`ListEditor`, `HeaderSectionEditor`, `CellSourceEditor`, `TableSectionEditor`, `PhotoSectionEditor`, `ImageSectionEditor`, `SignatureSectionEditor`, `TextSectionEditor`, `SectionEditor`, and `SECTION_TYPES`), importing the replacements instead; (b) rewrites `PageEditor` to use the new picker and card-based section list with page removal; (c) rewrites `TemplateEditor` into a two-column layout with the live preview pane; (d) rewrites the creation form to auto-slug the id.

- [ ] **Step 1: Replace the imports and delete the moved code**

Replace lines 1–36 of `src/components/admin/PdiTemplatesAdminPage.jsx` (from the top of the file through the end of `emptyDefinition()`) with:

```jsx
// CRM/src/components/admin/PdiTemplatesAdminPage.jsx
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Upload, Archive, ChevronDown, ChevronUp } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';
import { labelToKey } from '../../utils/pdiTemplateSlug';
import {
  FIELD_CLS, ListEditor, SECTION_TYPE_OPTIONS, AddSectionPicker, SectionEditorFor,
  sectionTypeOption, sectionCardTitle, collectAllKeys,
} from './PdiTemplateSectionEditors';
import PdiTemplatePreviewPane from './PdiTemplatePreviewPane';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function emptyDefinition() {
  return { pages: [{ sections: [] }] };
}
```

Then delete every one of these functions/constants entirely from the file (they now live in `PdiTemplateSectionEditors.jsx`): `SECTION_TYPES`, `emptySection`, `moveItem`, `ListEditor`, `FIELD_CLS`, `HeaderSectionEditor`, `CellSourceEditor`, `TableSectionEditor`, `PhotoSectionEditor`, `ImageSectionEditor`, `SignatureSectionEditor`, `TextSectionEditor`, `SectionEditor`.

Keep `STATUS_STYLES`, `StatusBadge`, and `formatDate` exactly as they are — those belong to the list view, untouched by this redesign.

- [ ] **Step 2: Rewrite `PageEditor`**

Replace the existing `PageEditor` function with:

```jsx
function PageEditor({ page, onChange, onRemove, definition }) {
  return (
    <div className="space-y-3">
      <ListEditor
        items={page.sections}
        onChange={(sections) => onChange({ ...page, sections })}
        addLabel="__unused__" // AddSectionPicker below replaces ListEditor's own add button for this list
        newRow={() => { throw new Error('unreachable — sections are added via AddSectionPicker, not ListEditor\'s own add button'); }}
        renderRow={(section, update) => <SectionCard section={section} onChange={update} definition={definition} />}
      />
      <AddSectionPicker onAdd={(newSection) => onChange({ ...page, sections: [...page.sections, newSection] })} />
      <button type="button" onClick={onRemove} className="text-xs text-gray-400 hover:text-red-500">
        Remove page
      </button>
    </div>
  );
}
```

Wait — `ListEditor` always renders its own "+ addLabel" button at the bottom (see `PdiTemplateSectionEditors.jsx`'s `ListEditor`), and there's no way to suppress it from the outside as written. Two real options, pick one and apply it consistently:

**Option chosen for this plan:** add an optional `hideAddButton` prop to `ListEditor` (a small, backward-compatible addition — every other `ListEditor` usage in `PdiTemplateSectionEditors.jsx` from Tasks 2–3 keeps working unchanged since the prop defaults to not hiding it). Go back to `src/components/admin/PdiTemplateSectionEditors.jsx` and change `ListEditor`'s signature and final button:

```jsx
export function ListEditor({ items, onChange, renderRow, newRow, addLabel, hideAddButton }) {
```

```jsx
      {!hideAddButton && (
        <button
          type="button"
          onClick={() => onChange([...items, newRow()])}
          className="flex items-center gap-1 text-xs font-medium text-amber-700 border border-amber-300 rounded px-2 py-1 hover:bg-amber-50"
        >
          <Plus size={14} /> {addLabel}
        </button>
      )}
```

Then `PageEditor`'s `ListEditor` call becomes:

```jsx
function PageEditor({ page, onChange, onRemove, definition }) {
  return (
    <div className="space-y-3">
      <ListEditor
        items={page.sections}
        onChange={(sections) => onChange({ ...page, sections })}
        hideAddButton
        newRow={() => null}
        renderRow={(section, update) => <SectionCard section={section} onChange={update} definition={definition} />}
      />
      <AddSectionPicker onAdd={(newSection) => onChange({ ...page, sections: [...page.sections, newSection] })} />
      <button type="button" onClick={onRemove} className="text-xs text-gray-400 hover:text-red-500">
        Remove page
      </button>
    </div>
  );
}
```

(`newRow: () => null` is never actually called since `hideAddButton` suppresses the only button that would call it — it's required only because `ListEditor`'s signature still expects the prop.)

- [ ] **Step 3: Add the `SectionCard` component**

Add this new component to `src/components/admin/PdiTemplatesAdminPage.jsx`, directly above `PageEditor`:

```jsx
// A section's collapsed-by-default card — expands to its editor on click.
// Collapsed by default keeps a multi-section page scannable instead of one
// long wall of open editors (the same "wall of content" problem this
// project's other PDI redesign this session solved a different way, for a
// different page).
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
      {expanded && (
        <div className="p-3 border-t border-gray-200">
          <SectionEditorFor section={section} onChange={onChange} definition={definition} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `TemplateEditor`**

Replace the existing `TemplateEditor` function entirely with:

```jsx
function TemplateEditor({ template, onClose, onSaved }) {
  const [name, setName] = useState(template.name);
  const [definition, setDefinition] = useState(template.definition);
  const [saving, setSaving] = useState(false);
  const { notifySuccess, notifyError } = useNotify();

  const save = async (statusPath) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates/${template.id}`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name, definition }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      if (statusPath) {
        const pubRes = await fetch(`${BASE_URL}/api/pdi/admin/templates/${template.id}/${statusPath}`, {
          method: 'POST', headers: authHeaders(),
        });
        if (!pubRes.ok) throw new Error((await pubRes.json()).error || 'Action failed');
      }
      notifySuccess('Template saved.');
      onSaved();
    } catch (err) {
      notifyError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removePage = (i) => {
    const page = definition.pages[i];
    if ((page.sections || []).length > 0) {
      if (!window.confirm(`Remove this page and its ${page.sections.length} section(s)? This can't be undone.`)) return;
    }
    setDefinition({ ...definition, pages: definition.pages.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="flex gap-4 items-start" style={{ minHeight: '70vh' }}>
      <div className="flex-1 min-w-0 space-y-4">
        <div className="flex items-center gap-3">
          <input className={FIELD_CLS + ' text-lg font-semibold'} value={name} onChange={(e) => setName(e.target.value)} />
          <span className="text-xs text-gray-400 shrink-0">id: {template.id}</span>
        </div>
        <div className="space-y-4">
          {definition.pages.map((page, i) => (
            <div key={i} className="border border-gray-300 rounded p-3">
              <div className="text-sm font-semibold mb-2">Page {i + 1}</div>
              <PageEditor
                page={page}
                definition={definition}
                onChange={(p) => {
                  const pages = [...definition.pages];
                  pages[i] = p;
                  setDefinition({ ...definition, pages });
                }}
                onRemove={() => removePage(i)}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDefinition({ ...definition, pages: [...definition.pages, { sections: [] }] })}
            className="flex items-center gap-1 text-sm font-medium text-amber-700 border border-amber-300 rounded px-3 py-1.5 hover:bg-amber-50"
          >
            <Plus size={16} /> Add page
          </button>
        </div>
        <div className="flex gap-2 pt-3 border-t border-gray-200">
          <button type="button" disabled={saving} onClick={() => save(null)} className="px-3 py-2 border rounded text-sm">Save</button>
          <button type="button" disabled={saving} onClick={() => save('publish')} className="flex items-center gap-1 px-3 py-2 bg-amber-500 text-white rounded text-sm"><Upload size={16} /> Save &amp; Publish</button>
          <button type="button" disabled={saving} onClick={() => save('archive')} className="flex items-center gap-1 px-3 py-2 border rounded text-sm text-gray-600"><Archive size={16} /> Archive</button>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-500">Close</button>
        </div>
      </div>
      <div className="w-96 shrink-0 sticky top-4" style={{ height: '70vh' }}>
        <PdiTemplatePreviewPane templateId={template.id} definition={definition} />
      </div>
    </div>
  );
}
```

Note: `collectAllKeys` is imported into this file (Step 1's import list) but not directly called anywhere in `TemplateEditor`/`PageEditor`/`SectionCard` — it's used transitively by every editor inside `SectionEditorFor`. Remove `collectAllKeys` from this file's import list if `npx eslint` (Step 6 below) flags it as unused; keep it only if some later step in this task ends up needing it directly. (It won't — this note exists so the implementer doesn't wonder whether to add a call for it.)

- [ ] **Step 5: Rewrite the creation form**

Replace the `export default function PdiTemplatesAdminPage()` function's state and `createTemplate` (keep `list`/`editing`/`refresh`/`openEditor`/`deleteTemplate` exactly as they are) with:

```jsx
  const [creatingName, setCreatingName] = useState('');
  const [creatingIdOverride, setCreatingIdOverride] = useState(null); // null = auto-generated; string once the admin edits it directly
  const [showIdAdvanced, setShowIdAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);

  const createTemplate = async () => {
    const trimmedName = creatingName.trim();
    if (!trimmedName) {
      notifyError('A name is required to create a template.');
      return;
    }
    setCreating(true);
    try {
      const baseId = creatingIdOverride !== null ? creatingIdOverride.trim() : labelToKey(trimmedName, []);
      const attempt = async (id) => {
        const res = await fetch(`${BASE_URL}/api/pdi/admin/templates`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ id, name: trimmedName, definition: emptyDefinition() }),
        });
        const body = await res.json();
        return { ok: res.ok, status: res.status, body };
      };

      let result = await attempt(baseId);
      // A 409 (id already exists) on an auto-generated id gets one silent
      // retry with a "-2" suffix — the admin never typed this id, so a
      // collision isn't something to surface immediately. If a manually-
      // entered id (creatingIdOverride set) 409s, don't auto-retry — go
      // straight to showing the error so they can pick deliberately.
      if (!result.ok && result.status === 409 && creatingIdOverride === null) {
        result = await attempt(`${baseId}-2`);
      }
      if (!result.ok) {
        if (result.status === 409) {
          setShowIdAdvanced(true);
          setCreatingIdOverride(baseId);
        }
        throw new Error(result.body.error || 'Create failed');
      }

      notifySuccess('Template created.');
      setCreatingName(''); setCreatingIdOverride(null); setShowIdAdvanced(false);
      await refresh();
      setEditing(result.body);
    } catch (err) {
      notifyError(err.message);
    } finally {
      setCreating(false);
    }
  };
```

Then replace the creation-form JSX block (the `<div className="bg-white rounded-xl shadow p-4 mb-6">...</div>` in the list view's return statement) with:

```jsx
        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <div className="text-sm font-semibold text-gray-700 mb-3">Create a new template</div>
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input className={FIELD_CLS} value={creatingName} onChange={(e) => setCreatingName(e.target.value)} placeholder="e.g. Acme Motor PDI" />
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

- [ ] **Step 6: Lint and build**

Run: `npx eslint src/components/admin/PdiTemplatesAdminPage.jsx src/components/admin/PdiTemplateSectionEditors.jsx`
Expected: no errors. Resolve any unused-import warnings by checking whether the code above actually ended up using that import (see Step 4's note about `collectAllKeys`), not by suppressing the rule.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/PdiTemplatesAdminPage.jsx src/components/admin/PdiTemplateSectionEditors.jsx
git commit -m "feat: rewire PDI template authoring page onto the new editors, add live preview pane and page removal"
```

---

### Task 6: Controller-personal live verification (not a subagent)

**Do this task yourself, in the main session — not via a dispatched subagent.** This mirrors how every previous phase of this project had its riskiest UI piece personally verified live before shipping.

- [ ] **Step 1: Start both servers and log in as an admin**

Start CRM_BACKEND and CRM's dev servers. This project's database is the shared production RDS instance (confirmed earlier this session) — if testing locally against it, follow the same discipline used earlier this session for the fill-out-form verification: create a throwaway admin identity, and delete every template/report you create for this test afterward.

- [ ] **Step 2: Create a template by name only**

On the list page, type only a Name (no id) and click New Template. Confirm the template is created and opens straight into the editor. Separately, try creating a second template with the exact same Name — confirm it succeeds with an auto-suffixed id (the silent `-2` retry), not an error.

- [ ] **Step 3: Build one section of each of the 7 types via the picker**

For each of Header, Checklist, Fill-in list, Photos, Image, Signatures, Notes: add one via "+ Add section", confirm the card shows the right type badge and a sensible collapsed title, fill in at least one field, and confirm the live preview pane updates within ~1s of the last edit (not on every keystroke) without a full-page flash. For the Checklist type specifically, confirm there is no way to change the GO/NG/NA result options anywhere in the UI.

- [ ] **Step 4: Drag-reorder**

Drag-reorder two sections within a page (confirm the order actually changes and persists on Save). Drag-reorder two items within a sub-list (e.g. two checklist items, or two header detail rows) — confirm the same.

- [ ] **Step 5: Remove pages**

Add a second page with zero sections, remove it — confirm it disappears with no confirmation prompt. Add a third page, add one section to it, try removing it — confirm a `window.confirm` prompt appears and cancelling it leaves the page intact.

- [ ] **Step 6: Round-trip through the fill-out form**

Publish the test template. Navigate to it via the PDI Generator picker (the already-redesigned fill-out experience from earlier this session) and fill it out, confirming every section built through the new editors behaves identically to how a hand-built equivalent would (Checklist renders as the GO/NG/NA button toggle, Fill-in list lets you add rows, Photos/Image/Signatures/Notes all work). Finalize and confirm a valid PDF downloads.

- [ ] **Step 7: Clean up and report status**

Delete every test template and report created during this pass (using the delete-template feature and report-delete, both already in place from earlier this session). If everything in Steps 2–6 passed, report DONE. If anything failed, fix it directly (this step is personal, not delegated), re-verify, then report DONE — do not hand off a known-broken UI as complete.
