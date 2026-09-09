# PDI Generic Fill-Out Form — UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `GenericPdiGeneratorForm.jsx`'s cramped single-scroll modal with a full-page, sidebar-navigated, autosaving fill-out experience — one section at a time, with undo-able deletes and a pre-finalize completeness check — while reusing all existing field-handling logic and data contracts unchanged.

**Architecture:** Same route, same top-level component, zero backend changes. `GenericPdiGeneratorForm.jsx` splits into three files: the existing per-section-type renderers move verbatim into a new `GenericPdiSections.jsx` (then get restyled), a new purely-presentational `GenericPdiSidebar.jsx` renders the section list/progress/navigation, and `GenericPdiGeneratorForm.jsx` itself is rebuilt around a full-page layout with autosave, undo, and a Review & Finalize step layered on top of the existing form state.

**Tech Stack:** React (hooks), react-modal (kept only for the photo crop dialog), axios, Tailwind CSS, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-09-pdi-generic-form-ux-redesign-design.md`

---

## Before you start: the photos-destructuring contract still applies

`GenericPdiGeneratorForm.jsx` sends report data as `{ data, photos }` where `photos` is pulled OUT of `form` via `const { photos, ...data } = form;` before every save/finalize call — `photos` must never end up nested inside `data` in a request body. Every task below that touches a save/autosave call must preserve this. This was flagged prominently in the original Phase 3 plan and is easy to lose when refactoring save logic.

---

### Task 1: Drag-and-drop photo upload in the shared `ImageUploadCard`

**Files:**
- Modify: `src/components/shared/PdiImageUpload.jsx:11-73`

This is independent of every other task — do it first, in isolation.

- [ ] **Step 1: Add a drag-over highlight state and drop handler to `ImageUploadCard`**

Replace the full `ImageUploadCard` function (lines 11-73) with:

```jsx
export function ImageUploadCard({ label, hint, value, onSelect, onClear, heightCls = 'h-40' }) {
  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!value) setDragActive(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragActive(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    if (value) return; // don't accept a drop on an already-filled slot — clear it first
    const file = e.dataTransfer.files?.[0];
    if (file) onSelect(file, null);
  };

  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed bg-gray-50 ${heightCls} flex items-center justify-center overflow-hidden ${
          dragActive ? 'border-amber-400 bg-amber-50' : value ? 'border-gray-200' : 'border-gray-300'
        }`}
      >
        {value ? (
          <>
            <img src={value} alt={label || 'Uploaded'} className="max-h-full max-w-full object-contain" />
            <button
              type="button"
              onClick={onClear}
              className="absolute top-1.5 right-1.5 p-1 bg-white/90 rounded-full shadow hover:bg-white text-gray-600 hover:text-red-500"
              title="Remove image"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <div className="flex items-center gap-5">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex flex-col items-center gap-1.5 hover:text-amber-500 transition-colors"
              >
                <Camera size={26} />
                <span className="text-xs font-medium">Take Photo</span>
              </button>
              <div className="w-px h-9 bg-gray-200" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-1.5 hover:text-amber-500 transition-colors"
              >
                <ImageIcon size={26} />
                <span className="text-xs font-medium">Choose File</span>
              </button>
            </div>
            <span className="text-[11px] text-gray-300">or drag a photo here</span>
          </div>
        )}
      </div>
      {/* capture="environment" opens the device camera directly — needed because
          Android's system Photo Picker (the default gallery chooser) has no camera
          shortcut of its own, by design (it's a privacy-scoped media picker). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => onSelect(e.target.files?.[0], e.target)}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onSelect(e.target.files?.[0], e.target)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add `useState` to the existing React import**

`PdiImageUpload.jsx` line 2 currently reads:

```js
import { useState, useRef, useCallback } from 'react';
```

`useState` is already imported (used by `CropModal`) — no change needed here. Confirm by reading the current import line; if `useState` were missing this step would add it, but it already covers both components.

- [ ] **Step 3: Lint and manually verify**

Run: `npx eslint src/components/shared/PdiImageUpload.jsx`
Expected: no errors.

Manually verify later, as part of Task 10's live pass, that dragging an image file onto an empty photo slot in the generic form attaches it (dropping onto an already-filled slot is a no-op by design — clear it first, matching how click-to-browse also requires clearing first).

- [ ] **Step 4: Commit**

```bash
git add src/components/shared/PdiImageUpload.jsx
git commit -m "feat: support drag-and-drop file upload in PDI photo slots"
```

---

### Task 2: Extract section renderers into `GenericPdiSections.jsx` (mechanical move)

**Files:**
- Create: `src/components/admin/GenericPdiSections.jsx`
- Modify: `src/components/admin/GenericPdiGeneratorForm.jsx:1-330`

This is a byte-faithful relocation — no behavior or styling changes in this task (styling changes are Task 3, on top of this). The goal is a reviewable diff: after this task, `git diff` on the new file should read as "these lines used to live in the other file," not "here's new logic."

- [ ] **Step 1: Create `GenericPdiSections.jsx` with the moved code**

Create `src/components/admin/GenericPdiSections.jsx`:

```jsx
// CRM/src/components/admin/GenericPdiSections.jsx
import { Fragment } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ImageUploadCard } from '../shared/PdiImageUpload';

export const INPUT_CLS =
  'w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400';
const TH_CLS = 'py-2 px-2 text-xs font-semibold text-gray-700 bg-amber-100 border border-gray-200 whitespace-nowrap';

// Same ceilings as PDIGeneratorForm.jsx, for the same reason: server.js's
// express.json({ limit: '25mb' }) caps the request body Save/Finalize send.
export const MAX_PHOTOS = 12;
export const MAX_ROWS = 100;

const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

// Builds a blank form-data object covering every dataKey/role the definition
// references, mirroring CRM_BACKEND's own buildSampleData (same walk, but
// blank values instead of sample placeholder text, since this is a genuinely
// empty new draft, not a PDF preview).
export function buildDefaultFormData(definition) {
  const data = { pdi_no: '' };
  definition.pages.forEach((page) => {
    page.sections.forEach((section) => {
      if (section.type === 'header') {
        section.infoFields.forEach((f) => {
          if (f.leftKey && data[f.leftKey] === undefined) data[f.leftKey] = f.leftFormat === 'date' ? todayIST() : '';
          if (f.rightKey && data[f.rightKey] === undefined) data[f.rightKey] = f.rightFormat === 'date' ? todayIST() : '';
        });
      } else if (section.type === 'table') {
        if (section.mode === 'repeatable') {
          data[section.dataKey] = [];
        } else {
          const sectionData = {};
          (section.fixedRows || []).forEach((row) => {
            const rowData = {};
            section.columns.forEach((c) => {
              if (c.cell && c.cell.source === 'sectionData') rowData[c.cell.subfield] = c.cell.default || '';
            });
            sectionData[row.key] = rowData;
          });
          data[section.dataKey] = sectionData;
        }
      } else if (section.type === 'text') {
        data[section.dataKey] = section.default || '';
      } else if (section.type === 'signature') {
        section.roles.forEach((r) => { data[r.key] = ''; });
      } else if (section.type === 'photo') {
        data[section.dataKey] = section.mode === 'fixed-slots' ? {} : [];
      } else if (section.type === 'image') {
        data[section.dataKey] = null;
      }
    });
  });
  return data;
}

export function makeEmptyRow(columns) {
  const row = {};
  columns.forEach((c) => { row[c.key] = ''; });
  return row;
}

/* ── Section renderers — one per type, mirroring CRM_BACKEND's renderer.js drawers ── */

function HeaderSection({ section, form, setField }) {
  return (
    <div className="grid grid-cols-2 gap-4 mb-4">
      {section.infoFields.map((f, i) => (
        <Fragment key={i}>
          {f.leftKey && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{f.leftLabel}</label>
              <input
                type={f.leftFormat === 'date' ? 'date' : 'text'}
                className={INPUT_CLS}
                value={form[f.leftKey] || ''}
                onChange={(e) => setField(f.leftKey, e.target.value)}
              />
            </div>
          )}
          {f.rightKey && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{f.rightLabel}</label>
              <input
                type={f.rightFormat === 'date' ? 'date' : 'text'}
                className={INPUT_CLS}
                value={form[f.rightKey] || ''}
                onChange={(e) => setField(f.rightKey, e.target.value)}
              />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function RepeatableTableSection({ section, form, addRow, removeRow, setCell }) {
  const cols = section.columns;
  const rows = form[section.dataKey] || [];
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        {section.title ? <h3 className="text-sm font-semibold text-gray-700">{section.title}</h3> : <span />}
        <button
          type="button"
          onClick={() => addRow(section.dataKey, cols)}
          disabled={rows.length >= MAX_ROWS}
          className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent text-xs font-medium"
        >
          <Plus size={14} /> Add Row
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-left">
          <thead>
            <tr>
              {cols.map((c) => <th key={c.key} className={TH_CLS}>{c.label}</th>)}
              <th className={TH_CLS} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                {cols.map((c) => {
                  if (!c.cell || c.cell.source === 'row') {
                    return (
                      <td key={c.key} className="py-1 px-1 border border-gray-100">
                        <input className={INPUT_CLS} value={row[c.key] || ''} onChange={(e) => setCell(section.dataKey, idx, c.key, e.target.value)} />
                      </td>
                    );
                  }
                  // 'constant' is the same value in every row; a repeatable row has no
                  // fixed row.key to look up in sectionData the way FixedTableSection
                  // does, so 'sectionData' here has no live per-row value — show the
                  // configured default instead, matching authoredTemplate.js's own
                  // resolveOverride fallback (sectionData[row.key] is always undefined
                  // for a repeatable row, so the renderer always prints cell.default too).
                  const displayVal = c.cell.source === 'constant' ? c.cell.value : c.cell.default;
                  return (
                    <td key={c.key} className="py-2 px-3 text-sm text-gray-500">{displayVal ?? ''}</td>
                  );
                })}
                <td className="py-1 px-1 border border-gray-100 text-center">
                  <button type="button" onClick={() => removeRow(section.dataKey, idx)} className="text-gray-400 hover:text-red-500">
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FixedTableSection({ section, form, setCell }) {
  const cols = section.columns;
  const sectionData = form[section.dataKey] || {};
  return (
    <div className="mb-6">
      {section.title && <h3 className="text-sm font-semibold text-gray-700 mb-2">{section.title}</h3>}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-left">
          <thead>
            <tr>{cols.map((c) => <th key={c.key} className={TH_CLS}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {(section.fixedRows || []).map((row) => (
              <tr key={row.key} className="border-t border-gray-100">
                {cols.map((c) => {
                  const editable = c.cell && c.cell.source === 'sectionData';
                  if (!editable) {
                    const displayVal = c.cell && c.cell.source === 'constant' ? c.cell.value : row[c.key];
                    return <td key={c.key} className="py-2 px-3 text-sm text-gray-500">{displayVal ?? ''}</td>;
                  }
                  const value = (sectionData[row.key] && sectionData[row.key][c.cell.subfield]) || '';
                  const isSelect = ['GO', 'NG', 'NA'].includes(String(c.cell.default || '').toUpperCase());
                  return (
                    <td key={c.key} className="py-1 px-2 border border-gray-100 text-center">
                      {isSelect ? (
                        <select className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)}>
                          {['GO', 'NG', 'NA'].map((o) => <option key={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FreeformPhotoSection({ section, form, addPhoto, removePhoto, setLabel, handleFileChosen, setImage }) {
  const photos = form[section.dataKey] || [];
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Photos</h3>
        <button
          type="button"
          onClick={() => addPhoto(section.dataKey)}
          disabled={photos.length >= MAX_PHOTOS}
          className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent text-xs font-medium"
        >
          <Plus size={14} /> Add Photo
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {photos.map((photo, idx) => (
          <div key={idx} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input className={INPUT_CLS} value={photo.label} onChange={(e) => setLabel(section.dataKey, idx, e.target.value)} placeholder={`Photo ${idx + 1} label`} />
              <button type="button" onClick={() => removePhoto(section.dataKey, idx)} className="shrink-0 p-1.5 text-gray-400 hover:text-red-500">
                <Trash2 size={16} />
              </button>
            </div>
            <ImageUploadCard
              value={photo.image}
              onSelect={(file, el) => handleFileChosen((dataUri) => setImage(section.dataKey, idx, dataUri), file, el)}
              onClear={() => setImage(section.dataKey, idx, null)}
              heightCls="h-32"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function FixedSlotPhotoSection({ section, form, handleFileChosen, setSlotImage }) {
  const slotData = form[section.dataKey] || {};
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Photos</h3>
      <div className="grid grid-cols-2 gap-4">
        {section.slots.map((slot) => (
          <ImageUploadCard
            key={slot.key}
            label={slot.label}
            value={slotData[slot.key]}
            onSelect={(file, el) => handleFileChosen((dataUri) => setSlotImage(section.dataKey, slot.key, dataUri), file, el)}
            onClear={() => setSlotImage(section.dataKey, slot.key, null)}
          />
        ))}
      </div>
    </div>
  );
}

function ImageSection({ section, form, handleFileChosen, setImageField }) {
  return (
    <div className="mb-6">
      <ImageUploadCard
        label={section.title || 'Image'}
        value={form[section.dataKey]}
        onSelect={(file, el) => handleFileChosen((dataUri) => setImageField(section.dataKey, dataUri), file, el)}
        onClear={() => setImageField(section.dataKey, null)}
        heightCls="h-28"
      />
    </div>
  );
}

function SignatureSection({ section, form, setField }) {
  return (
    <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: `repeat(${section.roles.length}, 1fr)` }}>
      {section.roles.map((role) => (
        <div key={role.key}>
          <label className="block text-sm font-medium text-gray-700 mb-1">{role.label}</label>
          <input className={INPUT_CLS} value={form[role.key] || ''} onChange={(e) => setField(role.key, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

function TextSection({ section, form, setField }) {
  return (
    <div className="mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-1">{section.label}</label>
      <textarea rows={2} className={INPUT_CLS} value={form[section.dataKey] ?? ''} onChange={(e) => setField(section.dataKey, e.target.value)} />
    </div>
  );
}

export function renderSection(section, ctx) {
  switch (section.type) {
    case 'header':
      return <HeaderSection key="header" section={section} form={ctx.form} setField={ctx.setField} />;
    case 'table':
      return section.mode === 'fixed'
        ? <FixedTableSection key={section.dataKey} section={section} form={ctx.form} setCell={ctx.setFixedCell} />
        : <RepeatableTableSection key={section.dataKey} section={section} form={ctx.form} addRow={ctx.addRepeatableRow} removeRow={ctx.removeRepeatableRow} setCell={ctx.setRepeatableCell} />;
    case 'photo':
      return section.mode === 'fixed-slots'
        ? <FixedSlotPhotoSection key={section.dataKey} section={section} form={ctx.form} handleFileChosen={ctx.handleFileChosen} setSlotImage={ctx.setFixedSlotImage} />
        : <FreeformPhotoSection key={section.dataKey} section={section} form={ctx.form} addPhoto={ctx.addFreeformPhoto} removePhoto={ctx.removeFreeformPhoto} setLabel={ctx.setFreeformPhotoLabel} handleFileChosen={ctx.handleFileChosen} setImage={ctx.setFreeformPhotoImage} />;
    case 'image':
      return <ImageSection key={section.dataKey} section={section} form={ctx.form} handleFileChosen={ctx.handleFileChosen} setImageField={ctx.setImageField} />;
    case 'signature':
      return <SignatureSection key="signature" section={section} form={ctx.form} setField={ctx.setField} />;
    case 'text':
      return <TextSection key={section.dataKey} section={section} form={ctx.form} setField={ctx.setField} />;
    default:
      return null;
  }
}
```

Note: `SELECT_CLS` from the original file is intentionally not carried over — it was only ever used by the GO/NG/NA `<select>`, which Task 3 replaces with a button toggle. `INPUT_CLS` is used above for that `<select>` as a placeholder styling only until Task 3 replaces it.

- [ ] **Step 2: Remove the moved code from `GenericPdiGeneratorForm.jsx` and import it instead**

In `GenericPdiGeneratorForm.jsx`, delete lines 13-329 entirely (from `const INPUT_CLS =` through the closing `}` of `renderSection`) — everything Step 1 moved. Replace the block of imports at the top (lines 1-9) with:

```jsx
// CRM/src/components/admin/GenericPdiGeneratorForm.jsx
import { useState, useRef, useCallback, useEffect } from 'react';
import Modal from 'react-modal';
import axios from 'axios';
import { useParams, useSearchParams } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';
import { CropModal } from '../shared/PdiImageUpload';
import { fileToDataUri, MAX_RAW_IMAGE_BYTES } from '../../utils/pdiImageUpload';
import { INPUT_CLS, MAX_PHOTOS, MAX_ROWS, buildDefaultFormData, makeEmptyRow, renderSection } from './GenericPdiSections';

const API_URL = import.meta.env.VITE_BACKEND_URL || '';
```

Note `import Modal from 'react-modal';` is kept here even though it looks unused by the code this task moves — the component body below (untouched by this task, starting at `export default function GenericPdiGeneratorForm()`) still renders `<Modal>` for its fill-out view at this point in the plan. It only becomes unused once Task 6 replaces that modal with the full-page layout — Task 6 removes this import line then, not now. Removing it in this task would break the build for every commit between here and Task 6.

(`Fragment` and `Plus`/`Trash2` are no longer needed directly in this file — they were only used by the section renderers that just moved. `ImageUploadCard` is also no longer imported here directly — the component body's remaining code never called it directly even before this move, only indirectly through the section renderers, which is why it's absent from this import list; only `GenericPdiSections.jsx` and `PdiImageUpload.jsx`'s own `CropModal` usage need it now, and `CropModal` usage stays as-is via the `CropModal` import above.)

- [ ] **Step 3: Verify nothing else changed**

Run: `git diff src/components/admin/GenericPdiGeneratorForm.jsx`
Expected: the diff shows only the import block changing and the moved block being deleted — the remainder of the file (the `GenericPdiGeneratorForm` component itself, from the original `export default function GenericPdiGeneratorForm()` onward) is untouched at this point.

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx src/components/admin/GenericPdiSections.jsx`
Expected: no errors (in particular, no unused-import errors — if any appear, they mean Step 2's import list doesn't exactly match what the remaining code in `GenericPdiGeneratorForm.jsx` still uses at this point in the plan; reconcile against what Tasks 5-9 will need as they land, not by re-adding something Step 1 already moved).

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/GenericPdiSections.jsx src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "refactor: extract PDI generic-form section renderers into GenericPdiSections.jsx"
```

---

### Task 3: Restyle tables — roomier layout, GO/NG/NA button toggle

**Files:**
- Modify: `src/components/admin/GenericPdiSections.jsx`

- [ ] **Step 1: Increase table padding and input size**

In `GenericPdiSections.jsx`, change the `TH_CLS` constant:

```js
const TH_CLS = 'py-3 px-3 text-xs font-semibold text-gray-700 bg-amber-100 border border-gray-200 whitespace-nowrap';
```

In `RepeatableTableSection`, there are two `<td>` elements with `className="py-1 px-1 border border-gray-100"` — the row-input cell (bare, no suffix) and the remove-button cell (same classes plus a trailing ` text-center`). Change both, keeping each one's own suffix:
- `className="py-1 px-1 border border-gray-100"` → `className="py-2 px-2 border border-gray-100"`
- `className="py-1 px-1 border border-gray-100 text-center"` → `className="py-2 px-2 border border-gray-100 text-center"`

The read-only display cell `className="py-2 px-3 text-sm text-gray-500"` appears twice in the file — once in `RepeatableTableSection` (the constant/sectionData-source column display) and once in `FixedTableSection` (the non-editable column display). Change **both** occurrences to `className="py-3 px-3 text-sm text-gray-500"` — both are read-only display cells and should get the same roomier treatment.

In `FixedTableSection`, change the editable `<td>`'s `className="py-1 px-2 border border-gray-100 text-center"` to `className="py-2 px-3 border border-gray-100 text-center"`.

- [ ] **Step 2: Replace the GO/NG/NA `<select>` with a 3-way button toggle**

In `FixedTableSection`, replace this block:

```jsx
{isSelect ? (
  <select className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)}>
    {['GO', 'NG', 'NA'].map((o) => <option key={o}>{o}</option>)}
  </select>
) : (
  <input className={INPUT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)} />
)}
```

with:

```jsx
{isSelect ? (
  <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
    {['GO', 'NG', 'NA'].map((o) => {
      const active = value === o;
      const activeCls = o === 'GO' ? 'bg-green-600 text-white' : o === 'NG' ? 'bg-red-600 text-white' : 'bg-gray-500 text-white';
      return (
        <button
          key={o}
          type="button"
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
```

This keeps the same `value`/`setCell(section.dataKey, row.key, c.cell.subfield, ...)` contract — only the widget changed, not the data flow.

- [ ] **Step 3: Lint and build**

Run: `npx eslint src/components/admin/GenericPdiSections.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/GenericPdiSections.jsx
git commit -m "style: roomier PDI table layout, GO/NG/NA becomes a button toggle"
```

---

### Task 4: `GenericPdiSidebar.jsx` — presentational section navigator

**Files:**
- Create: `src/components/admin/GenericPdiSidebar.jsx`

Purely presentational: takes pre-computed items, renders them. Does not know about the template definition's shape.

- [ ] **Step 1: Write the component**

Create `src/components/admin/GenericPdiSidebar.jsx`:

```jsx
// CRM/src/components/admin/GenericPdiSidebar.jsx
import { Check } from 'lucide-react';

// items: [{ key: string, label: string, filled: boolean }]
// activeKey: string — one of items[].key, or the literal 'review'
// onSelect: (key: string) => void
export default function GenericPdiSidebar({ templateName, items, activeKey, onSelect }) {
  const filledCount = items.filter((i) => i.filled).length;
  const totalCount = items.length;
  const pct = totalCount ? Math.round((filledCount / totalCount) * 100) : 0;

  return (
    <div className="w-60 shrink-0 bg-gray-50 border-r border-gray-200 px-4 py-5 overflow-y-auto">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2 truncate" title={templateName}>
        {templateName}
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden mb-4">
        <div className="h-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = activeKey === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelect(item.key)}
              className={`flex items-center justify-between px-2.5 py-2 rounded-lg text-sm text-left transition-colors ${
                active ? 'bg-white shadow-sm text-gray-900 font-semibold' : 'text-gray-600 hover:bg-white/70'
              }`}
            >
              <span className="truncate">{item.label}</span>
              {item.filled ? (
                <Check size={14} className="text-green-600 shrink-0" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-gray-300 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
      <div className="border-t border-gray-200 mt-3 pt-3">
        <button
          type="button"
          onClick={() => onSelect('review')}
          className={`w-full flex items-center px-2.5 py-2 rounded-lg text-sm text-left transition-colors ${
            activeKey === 'review' ? 'bg-white shadow-sm text-amber-700 font-semibold' : 'text-amber-700 hover:bg-white/70 font-medium'
          }`}
        >
          Review &amp; Finalize
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/components/admin/GenericPdiSidebar.jsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/GenericPdiSidebar.jsx
git commit -m "feat: add presentational sidebar navigator for the PDI generic form"
```

---

### Task 5: Flattened section list, labeling, and completion heuristic

**Files:**
- Modify: `src/components/admin/GenericPdiGeneratorForm.jsx`

This task only adds pure helper functions and a `useMemo`-derived list — no layout changes yet (Task 6 wires them into the UI).

- [ ] **Step 1: Add the flattening, labeling, and completion functions**

Add these functions in `GenericPdiGeneratorForm.jsx`, right after the `API_URL` constant (before the `export default function GenericPdiGeneratorForm()` line):

```jsx
function flattenSections(definition) {
  const flat = [];
  definition.pages.forEach((page, pageIdx) => {
    page.sections.forEach((section, sectionIdx) => {
      flat.push({ key: `${pageIdx}-${sectionIdx}`, section });
    });
  });
  return flat;
}

function baseSectionLabel(section) {
  switch (section.type) {
    case 'header': return 'Header';
    case 'table': return section.title || 'Table';
    case 'photo': return 'Photos';
    case 'image': return section.title || 'Image';
    case 'signature': return 'Signatures';
    case 'text': return section.label || 'Notes';
    default: return 'Section';
  }
}

// Disambiguates sections that would otherwise share an identical label
// (whether both fell back to the same default, or both used the same
// custom title) by appending " (2)", " (3)", ... in order of appearance.
function labelFlattenedSections(flat) {
  const seenCounts = new Map();
  return flat.map(({ key, section }) => {
    const base = baseSectionLabel(section);
    const count = (seenCounts.get(base) || 0) + 1;
    seenCounts.set(base, count);
    return { key, section, label: count === 1 ? base : `${base} (${count})` };
  });
}

function isSectionFilled(section, form) {
  switch (section.type) {
    case 'header':
      return section.infoFields.some((f) =>
        (f.leftKey && String(form[f.leftKey] || '').trim()) ||
        (f.rightKey && String(form[f.rightKey] || '').trim())
      );
    case 'table':
      if (section.mode === 'repeatable') {
        return (form[section.dataKey] || []).length > 0;
      }
      {
        const sectionData = form[section.dataKey] || {};
        const editableCols = section.columns.filter((c) => c.cell && c.cell.source === 'sectionData');
        return (section.fixedRows || []).some((row) =>
          editableCols.some((c) => String((sectionData[row.key] && sectionData[row.key][c.cell.subfield]) || '').trim())
        );
      }
    case 'photo':
      if (section.mode === 'fixed-slots') {
        const slotData = form[section.dataKey] || {};
        return section.slots.some((s) => !!slotData[s.key]);
      }
      return (form[section.dataKey] || []).some((p) => !!p.image);
    case 'image':
      return !!form[section.dataKey];
    case 'signature':
      return section.roles.some((r) => String(form[r.key] || '').trim());
    case 'text':
      return String(form[section.dataKey] || '').trim().length > 0;
    default:
      return false;
  }
}
```

- [ ] **Step 2: Derive the sidebar items list inside the component**

Inside `export default function GenericPdiGeneratorForm()`, after the existing `const [form, setForm] = useState(null);` line, add:

```jsx
  const [activeKey, setActiveKey] = useState(null); // one of the flattened keys, or 'review'

  const flatSections = definition ? labelFlattenedSections(flattenSections(definition)) : [];
  const sidebarItems = form
    ? flatSections.map(({ key, section, label }) => ({ key, section, label, filled: isSectionFilled(section, form) }))
    : [];
  const activeIndex = sidebarItems.findIndex((i) => i.key === activeKey);
  const activeEntry = activeIndex >= 0 ? sidebarItems[activeIndex] : null;
```

(This recomputes on every render rather than using `useMemo` — the codebase's other derived-from-state values in this file, e.g. `inspectedByValue()`/`inspectionDateValue()`, are already recomputed per-render the same way, and `sidebarItems` is only ever iterated, never a dependency of an expensive effect, so memoizing it would add complexity without a measurable benefit here.)

- [ ] **Step 3: Initialize `activeKey` whenever a form is freshly opened or resumed**

In `handleOpen`, right after `setForm(base);`, add:

```jsx
      setActiveKey(flattenSections(definition)[0]?.key ?? 'review');
```

In the resume-via-`?report=` effect, right after `setForm({...})` (the block ending `photos: hasRealPhotos ? reportPhotos : base.photos,`), add the same line:

```jsx
      setActiveKey(flattenSections(definition)[0]?.key ?? 'review');
```

(A template with zero sections is a degenerate/invalid case not expected to occur in practice — the `?? 'review'` fallback just avoids `activeKey` being `undefined` if it ever did.)

- [ ] **Step 4: Lint**

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx`
Expected: no errors. (`activeKey`/`sidebarItems` are unused by any rendered JSX until Task 6 — if ESLint flags them as unused, that's expected at this checkpoint only if the project's lint config flags unused top-level `const`s inside a component body, which it does not for values that are clearly read by the JSX added in Task 6; if you see an error here, double check you're running lint AFTER Task 6 lands, not in isolation — for this task alone, a quick manual read-through of the diff is sufficient verification instead of a strict lint gate, since `sidebarItems`/`activeIndex`/`activeEntry` are consumed starting in the very next task.)

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: add flattened section list, labeling, and completion heuristic for PDI generic form"
```

---

### Task 6: Full-page layout — replace the modal with sidebar + content + bars

**Files:**
- Modify: `src/components/admin/GenericPdiGeneratorForm.jsx`

This is the biggest structural change: the `<Modal>` block is replaced with a full-page view rendered in place of the landing card when `isOpen`. Section-renderer props/behavior are unchanged — only the surrounding chrome.

- [ ] **Step 1: Remove the old page-tab state — the sidebar supersedes it**

`activeTab` (`const [activeTab, setActiveTab] = useState(0);`) drove the old per-page tab navigation, which this task deletes entirely (Step 4 replaces it with the flattened-section content area). Left in place, it becomes dead code and fails Step 5's lint check.

Delete the `const [activeTab, setActiveTab] = useState(0);` line entirely.

Delete the `setActiveTab(0);` call in `handleOpen` (it sits right next to the `setForm(base);` line Task 5 Step 3 already added a `setActiveKey(...)` line after — remove only the `setActiveTab(0);` line, keep `setForm(base);` and the `setActiveKey(...)` line from Task 5).

Delete the `setActiveTab(0);` call in the resume-via-`?report=` effect (same situation — sits next to `setForm({...})` and the `setActiveKey(...)` line from Task 5; remove only `setActiveTab(0);`).

- [ ] **Step 2: Add navigation helpers — the `ctx` object stays as-is, add Previous/Next**

Right after the `ctx` object definition (`const ctx = form ? { ... } : null;`), add:

```jsx
  const goToIndex = (idx) => {
    if (idx < 0 || idx >= sidebarItems.length) return;
    setActiveKey(sidebarItems[idx].key);
  };
  const goPrevious = () => goToIndex(activeIndex - 1);
  const goNext = () => goToIndex(activeIndex + 1);
```

- [ ] **Step 3: Add the `ReviewPanel` sub-component**

Add this above `export default function GenericPdiGeneratorForm()`, alongside the Task 5 helper functions:

```jsx
function ReviewPanel({ items, onFinalizeAnyway, finalizing }) {
  const incomplete = items.filter((i) => !i.filled);
  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-bold text-gray-800 mb-2">Review &amp; Finalize</h2>
      {incomplete.length === 0 ? (
        <p className="text-sm text-gray-500 mb-6">Every section has at least some data filled in. You're good to finalize.</p>
      ) : (
        <p className="text-sm text-amber-700 mb-4">
          {incomplete.length} section{incomplete.length === 1 ? '' : 's'} still empty: {incomplete.map((i) => i.label).join(', ')}.
        </p>
      )}
      <ul className="space-y-1.5 mb-6">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-sm">
            <span className={i.filled ? 'text-green-600' : 'text-gray-300'}>{i.filled ? '✓' : '○'}</span>
            <span className={i.filled ? 'text-gray-700' : 'text-gray-400'}>{i.label}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onFinalizeAnyway}
        disabled={finalizing}
        className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
      >
        <Download size={16} />
        {finalizing ? 'Finalizing...' : 'Finalize Anyway'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Replace `handleFinalize` with `doFinalize(force)`**

Replace the entire existing `handleFinalize` function with:

```jsx
  const doFinalize = async (force) => {
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    if (!reportId) { notifyError('Report not initialized yet — please close and reopen the form.'); return; }
    if (!force && sidebarItems.some((i) => !i.filled)) {
      setActiveKey('review');
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, inspected_by: inspectedByValue(),
        inspection_date: inspectionDateValue(form),
      }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      setHasSaved(true);

      const response = await axios.post(`${API_URL}/api/pdi/reports/${reportId}/finalize`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
        signal: controller.signal,
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_${form.pdi_no.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('PDI finalized and PDF downloaded successfully.');
      setIsOpen(false);
      setReportId(null);
      setHasSaved(false);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to finalize PDI.');
        } catch {
          notifyError('Failed to finalize PDI.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to finalize PDI.');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };
```

- [ ] **Step 5: Replace the final return block's `<Modal>` with the full-page view**

Replace everything from `return (` at the end of the component (the block starting with `<div className="min-h-screen bg-gradient-to-br from-amber-50 to-gray-100 p-8">` and its `<Modal>`) through the final closing `);` and `}` with:

```jsx
  if (isOpen && form) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="text-amber-500 shrink-0" size={22} />
            <h1 className="text-lg font-bold text-gray-800 truncate">{templateName}</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500">PDI No.</label>
              <input className={INPUT_CLS + ' w-40'} value={form.pdi_no} onChange={(e) => setField('pdi_no', e.target.value)} placeholder="e.g. PDI-2026-001" />
            </div>
            <span className="text-xs text-gray-400 w-36 text-right shrink-0">{SAVE_STATUS_LABEL[saveStatus]}</span>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <GenericPdiSidebar templateName={templateName} items={sidebarItems} activeKey={activeKey} onSelect={setActiveKey} />
          <div className="flex-1 overflow-y-auto px-10 py-8">
            {activeKey === 'review' ? (
              <ReviewPanel items={sidebarItems} onFinalizeAnyway={() => doFinalize(true)} finalizing={loading} />
            ) : (
              activeEntry && renderSection(activeEntry.section, ctx)
            )}
          </div>
        </div>

        <div className="flex justify-between gap-3 px-8 py-4 border-t border-gray-200 bg-white shrink-0">
          <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 text-sm font-semibold">
            {saving ? 'Saving...' : 'Save Progress'}
          </button>
          <div className="flex items-center gap-3">
            <button type="button" onClick={goPrevious} disabled={activeIndex <= 0} className="px-4 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 text-sm">
              &larr; Previous
            </button>
            <button type="button" onClick={goNext} disabled={activeIndex < 0 || activeIndex >= sidebarItems.length - 1} className="px-4 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 text-sm">
              Next &rarr;
            </button>
            <button type="button" onClick={handleClose} className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 text-sm">
              Back
            </button>
            <button
              type="button"
              onClick={() => doFinalize(false)}
              disabled={loading}
              className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
            >
              <Download size={16} />
              {loading ? 'Finalizing...' : 'Finalize & Generate PDF'}
            </button>
          </div>
        </div>

        {cropTarget && <CropModal imageSrc={cropTarget.imageSrc} onCancel={cancelCrop} onApply={applyCroppedImage} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-gray-100 p-8">
      <h1 className="text-4xl font-bold text-gray-800 mb-10 text-center">{templateName}</h1>

      <div className="max-w-3xl mx-auto">
        <div
          onClick={handleOpen}
          className="bg-white rounded-2xl shadow-lg p-8 cursor-pointer hover:shadow-xl transition-shadow border-2 border-dashed border-amber-300 flex items-center gap-6"
        >
          <div className="p-4 bg-amber-100 rounded-xl">
            <FileText size={40} className="text-amber-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-800">New {templateName}</h2>
            <p className="text-gray-500 mt-1">Fill in the details and generate a PDF report.</p>
            <span className="inline-block mt-3 px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium">
              + Create PDI
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

Note: `Modal` (the `react-modal` default import) is no longer used directly in this file — only `CropModal` (which internally uses `react-modal` itself, inside `PdiImageUpload.jsx`) is still needed. Remove the now-unused `import Modal from 'react-modal';` line from the top of the file.

Add a `SAVE_STATUS_LABEL` lookup near the top of the file (below the `API_URL` constant, alongside the Task 5 helper functions):

```jsx
const SAVE_STATUS_LABEL = {
  idle: '',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'All changes saved',
  error: "Couldn't save — retrying",
};
```

(`saveStatus` state itself is added in Task 7 — for this task, reference it as if it exists; Task 7 adds the `useState` that backs it. If executing tasks strictly in order, `saveStatus` will be `undefined` until Task 7 lands, which only affects the label text shown, not functionality — `SAVE_STATUS_LABEL[undefined]` is simply `undefined`, rendered as nothing. This is acceptable as an intermediate state between Task 6 and Task 7 commits, matching how Task 5 also left `activeKey`/`sidebarItems` unconsumed for one task before being wired in.)

- [ ] **Step 6: Lint and build**

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx`
Expected: no errors (in particular, `saveStatus` referenced-but-not-yet-declared would be a `no-undef` error — if so, add a placeholder `const [saveStatus] = useState('idle');` in this task and let Task 7 upgrade it to the full autosave state; prefer this over leaving a lint error uncommitted).

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: replace PDI generic form modal with full-page sidebar-navigated view"
```

---

### Task 7: Autosave — two independent channels

**Files:**
- Modify: `src/components/admin/GenericPdiGeneratorForm.jsx`

**Data channel**: debounced 1.5s after the last non-photos field change, sends `{ data, status, inspected_by, inspection_date }`. **Photos channel**: sends `{ photos }` immediately on any photo mutation. Both use a stable (never-recreated) callback that reads current values from refs, so neither closes over stale `form`/`reportId` — this is the standard "latest ref" pattern for keeping a `useCallback([])` callback correct without re-creating it (and therefore without re-triggering the effects that schedule it) on every keystroke.

- [ ] **Step 1: Replace the placeholder `saveStatus` state (if Task 6 added one) with the full autosave machinery**

Add these, right after the existing `const [hasSaved, setHasSaved] = useState(false);` line:

```jsx
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

  // "Latest ref" pattern: these mirror the newest render's values so the
  // stable (useCallback([])) save functions below never act on stale data,
  // without needing to be recreated (and therefore re-scheduled) every render.
  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);
  const reportIdRef = useRef(reportId);
  useEffect(() => { reportIdRef.current = reportId; }, [reportId]);
  const inspectedByRef = useRef(() => undefined);
  const inspectionDateRef = useRef(() => undefined);

  const dataSaveTimerRef = useRef(null);
  const dataInFlightRef = useRef(false);
  const dataPendingRef = useRef(false);
  const photosInFlightRef = useRef(false);
  const photosPendingRef = useRef(false);
  // Guards against the initial setForm(base) in handleOpen/resume itself
  // triggering an autosave of a still-blank draft — reset to false whenever
  // a fresh form is established (see Step 3).
  const skippedFirstDataChangeRef = useRef(false);
  const skippedFirstPhotosChangeRef = useRef(false);

  const runDataSave = useCallback(async () => {
    if (!reportIdRef.current) return;
    if (dataInFlightRef.current) { dataPendingRef.current = true; return; }
    dataInFlightRef.current = true;
    setSaveStatus('saving');
    try {
      const token = localStorage.getItem('token');
      const { photos, ...data } = formRef.current;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
        data, status: 'In Progress',
        inspected_by: inspectedByRef.current(), inspection_date: inspectionDateRef.current(formRef.current),
      }, { headers: { Authorization: `Bearer ${token}` } });
      setHasSaved(true);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    } finally {
      dataInFlightRef.current = false;
      if (dataPendingRef.current) {
        dataPendingRef.current = false;
        runDataSave();
      }
    }
  }, []);

  const runPhotosSave = useCallback(async () => {
    if (!reportIdRef.current) return;
    if (photosInFlightRef.current) { photosPendingRef.current = true; return; }
    photosInFlightRef.current = true;
    setSaveStatus('saving');
    try {
      const token = localStorage.getItem('token');
      await axios.patch(`${API_URL}/api/pdi/reports/${reportIdRef.current}`, {
        photos: formRef.current.photos,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setHasSaved(true);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    } finally {
      photosInFlightRef.current = false;
      if (photosPendingRef.current) {
        photosPendingRef.current = false;
        runPhotosSave();
      }
    }
  }, []);
```

- [ ] **Step 2: Keep `inspectedByRef`/`inspectionDateRef` pointed at the latest closures**

Right after the existing `inspectedByValue`/`inspectionDateValue` function declarations (they stay exactly as they are today — no changes to their bodies), add:

```jsx
  useEffect(() => {
    inspectedByRef.current = inspectedByValue;
    inspectionDateRef.current = inspectionDateValue;
  });
```

(No dependency array — this intentionally runs after every render, so the refs always hold the version of these two functions that closed over the current `form`/`definition`.)

- [ ] **Step 3: Wire the two debounce/trigger effects, and reset the skip-guards on open/resume**

Add these effects near the other `useEffect`s in the component body:

```jsx
  const dataSignature = form ? JSON.stringify((({ photos, ...rest }) => rest)(form)) : null;
  useEffect(() => {
    if (!form || !isOpen) return;
    if (!skippedFirstDataChangeRef.current) { skippedFirstDataChangeRef.current = true; return; }
    setSaveStatus('unsaved');
    if (dataSaveTimerRef.current) clearTimeout(dataSaveTimerRef.current);
    dataSaveTimerRef.current = setTimeout(runDataSave, 1500);
    return () => clearTimeout(dataSaveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSignature]);

  const photosSignature = form ? JSON.stringify(form.photos) : null;
  useEffect(() => {
    if (!form || !isOpen) return;
    if (!skippedFirstPhotosChangeRef.current) { skippedFirstPhotosChangeRef.current = true; return; }
    runPhotosSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photosSignature]);
```

In `handleOpen`, right before `setForm(base);`, add:

```jsx
      skippedFirstDataChangeRef.current = false;
      skippedFirstPhotosChangeRef.current = false;
```

In the resume-via-`?report=` effect, right before its `setForm({...})` call, add the same two lines.

- [ ] **Step 4: Update `handleSave` (manual "Save Progress") to force-flush and reset debounce state**

Replace the existing `handleSave` function body with:

```jsx
  const handleSave = async () => {
    if (!reportId) return;
    if (dataSaveTimerRef.current) clearTimeout(dataSaveTimerRef.current);
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    setSaveStatus('saving');
    try {
      // See the contract note at the top of this task — this destructuring
      // is load-bearing, not optional style. Do not send `photos` inside `data`.
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, status: 'In Progress', inspected_by: inspectedByValue(),
        inspection_date: inspectionDateValue(form),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setHasSaved(true);
      setSaveStatus('saved');
      notifySuccess('Progress saved.');
    } catch (err) {
      setSaveStatus('error');
      notifyError(err.response?.data?.error || 'Failed to save progress.');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 5: Lint and build**

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 6: Commit**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: add two-channel autosave (data debounced, photos immediate) to PDI generic form"
```

---

### Task 8: Undo-able delete for rows and freeform photos

**Files:**
- Modify: `src/components/admin/GenericPdiGeneratorForm.jsx`

Only one toast at a time — a new removal replaces the previous toast, and the earlier removal becomes final immediately (its `restore` closure becomes unreachable).

- [ ] **Step 1: Add undo state and the toast component**

Add near the other `useState`/`useRef` declarations:

```jsx
  const [undoState, setUndoState] = useState(null); // { message, restore: () => void } | null
  const undoTimerRef = useRef(null);

  const showUndo = useCallback((message, restore) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState({ message, restore });
    undoTimerRef.current = setTimeout(() => setUndoState(null), 5000);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoState((current) => {
      current?.restore();
      return null;
    });
  }, []);
```

Add this component alongside `ReviewPanel` (above `export default function GenericPdiGeneratorForm()`):

```jsx
function UndoToast({ message, onUndo }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white rounded-lg shadow-lg px-4 py-3 flex items-center gap-4 z-50">
      <span className="text-sm">{message}</span>
      <button type="button" onClick={onUndo} className="text-amber-400 text-sm font-semibold hover:text-amber-300">
        Undo
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `removeRepeatableRow` and `removeFreeformPhoto` to go through `showUndo`**

Replace the existing `removeRepeatableRow`:

```jsx
  const removeRepeatableRow = useCallback((dataKey, idx) => {
    setForm((prev) => {
      const removedRow = prev[dataKey][idx];
      showUndo('Row removed', () => {
        setForm((p2) => {
          const rows = [...p2[dataKey]];
          rows.splice(idx, 0, removedRow);
          return { ...p2, [dataKey]: rows };
        });
      });
      return { ...prev, [dataKey]: prev[dataKey].filter((_, i) => i !== idx) };
    });
  }, [showUndo]);
```

Replace the existing `removeFreeformPhoto`:

```jsx
  const removeFreeformPhoto = useCallback((dataKey, idx) => {
    setForm((prev) => {
      const removedPhoto = prev[dataKey][idx];
      showUndo('Photo removed', () => {
        setForm((p2) => {
          const list = [...p2[dataKey]];
          list.splice(idx, 0, removedPhoto);
          return { ...p2, [dataKey]: list };
        });
      });
      return { ...prev, [dataKey]: prev[dataKey].filter((_, i) => i !== idx) };
    });
  }, [showUndo]);
```

- [ ] **Step 3: Render the toast**

In the full-page view's return block (added in Task 6), right after the `{cropTarget && <CropModal ... />}` line, add:

```jsx
        {undoState && <UndoToast message={undoState.message} onUndo={handleUndo} />}
```

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx`
Expected: no errors.

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: undo-able row/photo deletion in PDI generic form"
```

---

### Task 9: Verify the Review & Finalize gate end-to-end in code

**Files:**
- Modify: none expected (this task is a targeted re-check of Task 6's `doFinalize`/`ReviewPanel` wiring now that Tasks 7-8 have landed on top of it)

Tasks 6, 7, and 8 all touch the same file in sequence; this task exists to catch any merge-order mistake before the live verification pass, since `doFinalize`, `sidebarItems`, `showUndo`, and the autosave refs all now coexist in one large component.

- [ ] **Step 1: Re-read the full component and confirm wiring**

Run: `npx eslint src/components/admin/GenericPdiGeneratorForm.jsx src/components/admin/GenericPdiSections.jsx src/components/admin/GenericPdiSidebar.jsx src/components/shared/PdiImageUpload.jsx`
Expected: no errors across all four files.

Read the full current `GenericPdiGeneratorForm.jsx` and confirm:
- `doFinalize(force)` is called with `force=false` from the bottom bar's Finalize button and `force=true` from `ReviewPanel`'s `onFinalizeAnyway`.
- `sidebarItems` is computed from `form` (not stale) on every render, so `doFinalize`'s completeness check always reflects the latest field values.
- `activeKey` defaults to the first flattened section (not `'review'`) on a fresh open, per Task 5 Step 3 — `'review'` is only reached by explicit navigation or the incomplete-Finalize redirect.
- The `photos` destructuring contract (see "Before you start" at the top of this plan) holds in `doFinalize`, `handleSave`, `runDataSave`, and `runPhotosSave` — `photos` is never nested inside `data` in any request body.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: builds successfully, no warnings beyond the pre-existing chunk-size warning.

- [ ] **Step 3: Commit (only if Step 1's read-through surfaced a fix)**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "fix: correct PDI generic form wiring found during pre-verification review"
```

If no fix was needed, skip this step — there is nothing to commit.

---

### Task 10: Controller-personal live verification (not a subagent)

**Do this task yourself, in the main session — not via a dispatched subagent.** This mirrors how every previous phase of this PDI project had its riskiest UI piece personally verified live before shipping. Use the gstack skill for the live full-stack check.

- [ ] **Step 1: Start both servers**

Start CRM_BACKEND (`node server.js` or the project's usual dev command) and CRM's dev server (`npm run dev`). Confirm both are up.

- [ ] **Step 2: Get or create a published template covering all 6 section types**

If a template from earlier in this project's rugged-testing pass still exists and is `active`, reuse it. Otherwise author one via `/pdi-templates` covering header, table (repeatable), table (fixed with a GO/NG/NA-style column), photo (freeform or fixed-slots), image, signature, and text sections, then publish it.

- [ ] **Step 3: Open it from the picker and verify the new full-page flow**

- Confirm clicking the template's card opens the full-page view (not a modal) with the sidebar, top bar (template name, PDI No. field, save-status indicator), and bottom bar all visible.
- Click through every sidebar entry; confirm the content area swaps to that section and the sidebar highlights the active one.
- Fill in a header field; confirm its sidebar row's indicator flips from empty-dot to checkmark, and the progress bar advances.
- Confirm `← Previous` / `Next →` step through sections in order and are disabled at the first/last section respectively.

- [ ] **Step 4: Verify autosave**

- Type into a text field, wait ~2s without further changes, and confirm the status indicator moves `Unsaved changes` → `Saving…` → `All changes saved`.
- Open the browser's network tab; confirm the resulting `PATCH` request body has a `data` key and no `photos` key.
- Add a photo; confirm a separate `PATCH` fires promptly with a `photos` key and no `data` key.
- Reload the page mid-fill (after autosave has fired at least once) and resume via the dashboard's Resume action (or re-navigate with the same `?report=` id); confirm the typed data and added photo are still present.

- [ ] **Step 5: Verify undo**

- Add two rows to a repeatable table, remove one; confirm the "Row removed · Undo" toast appears and clicking Undo restores it at its original position.
- Remove a row, then immediately remove a second row before the first toast times out; confirm only the second toast is shown and the first removal is not recoverable (matches the spec's single-toast-replaces-previous rule).
- Repeat both checks for a freeform photo.

- [ ] **Step 6: Verify drag-and-drop**

Drag an image file from the file system onto an empty photo slot; confirm it attaches and opens the crop dialog exactly as click-to-browse does.

- [ ] **Step 7: Verify the Review & Finalize gate**

- With at least one section still empty, click "Finalize & Generate PDF" in the bottom bar; confirm it does NOT submit, and instead navigates to "Review & Finalize" showing the correct list of incomplete sections.
- Click "Finalize Anyway"; confirm it proceeds to save, finalize, and download a PDF.
- Separately, fully fill in every section of a fresh report and click "Finalize & Generate PDF" from the bottom bar directly; confirm it submits immediately without visiting the Review screen.

- [ ] **Step 8: Verify the PDF itself is unchanged**

Compare the downloaded PDF's structure (page layout, fonts, table rendering) against a PDF generated from the same template/data before this redesign (or against General/AutoNXT's still-untouched output as a sanity check that `renderer.js` itself wasn't affected). Confirm no visual regression in the generated PDF — this phase never touched `renderer.js`, `authoredTemplate.js`, or `pdi_generator.js`, so output should be identical for identical input data.

- [ ] **Step 9: Report status**

If every check in Steps 3-8 passes: report DONE, summarizing what was verified.
If anything fails: fix it directly (this step is personal, not delegated), re-verify, then report DONE — do not hand a known-broken UI off as complete.
