# PDI Generic Fill-Out Form (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a PDI template through the existing admin authoring UI, and it should be immediately fillable and generate a PDF — no developer writes a form component for it.

**Architecture:** One small non-admin-gated backend endpoint exposes a published template's definition. A new React component walks that definition's `pages → sections` and renders one form field per section, mirroring exactly how the PDF side already has one drawer per section type. A new route (`/pdi-generator/:templateId`) catches any template id General's and AutoNXT's own literal routes don't already claim.

**Tech Stack:** Express/PostgreSQL (one new endpoint, no schema change), React (one new component + a shared image-upload utility extracted from an existing one).

**Reference:** `docs/superpowers/specs/2026-09-08-pdi-generic-fill-form-design.md`

---

## Before you start — a data-flow subtlety you must preserve exactly

`models/operations/pdiReports.js`'s `finalizeReport`/`getPdfBuffer` do `{ ...(report.data || {}), photos: report.photos || [] }` before rendering — the separate `photos` DB column always overwrites whatever's under the `photos` key in `data` at render time. General's and AutoNXT's hand-coded forms already work around this correctly: both do `const { photos, ...data } = form;` right before every PATCH/POST, so whichever field is literally named `photos` in their form state is *excluded* from `data` and sent as its own top-level field instead — matching exactly what the backend column-merge expects.

The generic form's `form` state will naturally have a key literally named `photos` if (and only if) some section in the template happens to use `dataKey: 'photos'` (the obvious, expected name for a photo section, following General's/AutoNXT's own convention). **The exact same `const { photos, ...data } = form;` destructuring must be used in this new form's save/finalize handlers, unchanged.** If a template's photo section uses a *different* dataKey (e.g. `motor_photos`), `form.photos` is simply `undefined`, the destructuring is a no-op, that section's data flows through `data.motor_photos` normally, and the backend's column-merge — which only ever touches the literal key `photos` — never comes near it. This works correctly for *any* dataKey choice without special-casing, but only if this destructuring pattern is applied uniformly, exactly as written in Task 3 below. Do not "simplify" this away — sending the full `form` object as `data` without excluding `photos`, while *also* sending a separate `photos` field, would make a *second* save silently overwrite fresh photo data with a stale copy from an earlier save (the exact class of bug already fixed once this session, in commit `a64f6f9`).

---

### Task 1: Backend — non-admin endpoint to fetch a published template's definition

**Files:**
- Modify: `controllers/operations/pdi.controller.js`
- Modify: `routes/operations/pdi.js`
- Test: `tests/pdiReports.test.js`

The existing `controllers/operations/pdi.controller.js` reads:
```js
const templates = require('../../models/operations/pdi/templates');
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
const logger = require('../../utils/logger');

exports.getTemplates = async (req, res) => {
  try {
    const codeList = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
    const dbList = await AuthoredTemplates.listActive();
    res.json([...codeList, ...dbList]);
  } catch (error) {
    logger.error(`Error listing PDI templates: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 1: Add the new handler**

Append to the same file:
```js

exports.getTemplateDefinition = async (req, res) => {
  try {
    const { id } = req.params;
    // Code-registered templates (general, autonxt) already have their own
    // hand-coded forms and aren't meant to be fetched this way — treat as
    // not-found rather than leaking their internal structure through a route
    // that exists specifically to serve admin-authored templates.
    if (templates[id]) return res.status(404).json({ error: 'Template not found' });

    const row = await AuthoredTemplates.getActive(id);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json({ id: row.id, name: row.name, version: row.version, definition: row.definition });
  } catch (error) {
    logger.error(`Error fetching PDI template definition ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
```

- [ ] **Step 2: Add the route**

In `routes/operations/pdi.js`, currently:
```js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.controller');

router.get('/templates', authenticateToken, controller.getTemplates);

module.exports = router;
```
Add one line (no admin gate — deliberately, per the design spec, since any authenticated user needs to be able to fill out a template, not just admins):
```js
router.get('/templates', authenticateToken, controller.getTemplates);
router.get('/templates/:id/definition', authenticateToken, controller.getTemplateDefinition);
```

- [ ] **Step 3: Write tests**

Append to `tests/pdiReports.test.js`, inside the existing `describe('PDI Reports API', ...)` block:
```js
  it('GET /templates/:id/definition: 404 for a draft template, 200 with the definition once active', async () => {
    const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');
    const id = 'test-definition-endpoint-' + Date.now();
    await AuthoredTemplates.create({ id, name: 'Definition Endpoint Test', definition: { pages: [{ sections: [] }] } });

    const draftRes = await request(app)
      .get(`/api/pdi/templates/${id}/definition`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(draftRes.statusCode).toBe(404);

    await AuthoredTemplates.saveNewVersion(id, { status: 'active' });
    const activeRes = await request(app)
      .get(`/api/pdi/templates/${id}/definition`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.body.definition).toEqual({ pages: [{ sections: [] }] });

    await pool.query('DELETE FROM pdi_templates WHERE id = $1', [id]);
  });

  it('GET /templates/:id/definition: 404 for a code-registered template id (it has its own hand-coded form instead)', async () => {
    const res = await request(app)
      .get('/api/pdi/templates/general/definition')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('GET /templates/:id/definition: works for a non-admin user (no admin gate on this route)', async () => {
    const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');
    const jwt = require('jsonwebtoken');
    const id = 'test-definition-nonadmin-' + Date.now();
    await AuthoredTemplates.create({ id, name: 'Definition Endpoint NonAdmin Test', definition: { pages: [{ sections: [] }] } });
    await AuthoredTemplates.saveNewVersion(id, { status: 'active' });

    const nonAdmin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 2) RETURNING user_id`,
      ['Definition Endpoint NonAdmin', `def-endpoint-nonadmin-${Date.now()}@example.com`]
    );
    const nonAdminToken = jwt.sign({ user_id: nonAdmin.rows[0].user_id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get(`/api/pdi/templates/${id}/definition`)
      .set('Authorization', `Bearer ${nonAdminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.definition).toEqual({ pages: [{ sections: [] }] });

    await pool.query('DELETE FROM pdi_templates WHERE id = $1', [id]);
    await pool.query('DELETE FROM users WHERE user_id = $1', [nonAdmin.rows[0].user_id]);
  });
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/pdiReports.test.js --forceExit`
Expected: PASS (17/17 — 14 existing + 3 new). This starts the full Express app and may leave a stray `node` process on port 8000 across separate test runs in this session — if a later command hits `EADDRINUSE :::8000`, that's leftover from an earlier run, not a real failure; find/kill via `netstat -ano | grep :8000` if it blocks you.

- [ ] **Step 5: Commit**

```bash
git add controllers/operations/pdi.controller.js routes/operations/pdi.js
git add -f tests/pdiReports.test.js
git commit -m "feat: add non-admin endpoint to fetch a published PDI template's definition"
```

Note: this repo's `.gitignore` has a broad `*.test.js` rule that blocks plain `git add` on test files — use `git add -f` for the test file (known, pre-existing repo quirk).

---

### Task 2: Frontend — extract shared image-upload utilities

**Files:**
- Create: `CRM/src/utils/pdiImageUpload.jsx`

Read `CRM/src/components/admin/PDIGeneratorForm.jsx` in full first if you want to see the original — this task extracts `fileToDataUri`, `loadImage`, `cropAndCompress`, `ImageUploadCard`, `CropModal`, and their constants verbatim into a shared module, so the new generic form (Task 3) doesn't need a third copy of this logic. **`PDIGeneratorForm.jsx` and `AutoNXTGeneratorForm.jsx` are not modified by this task at all** — they keep their own existing copies exactly as they are; this is a pure addition.

- [ ] **Step 1: Write the shared module**

```jsx
// CRM/src/utils/pdiImageUpload.jsx
import { useState, useRef, useCallback } from 'react';
import Modal from 'react-modal';
import Cropper from 'react-easy-crop';
import { Image as ImageIcon, X, Camera } from 'lucide-react';
import { useNotify } from '../hooks/useNotify';

Modal.setAppElement('#root');

// Every image goes through crop + client-side compression before upload, so
// the *sent* payload stays small regardless of source size — this raw cap is
// just a backstop against absurd files before we even try to decode them.
export const MAX_RAW_IMAGE_BYTES = 20 * 1024 * 1024;
export const CROP_ASPECT = 4 / 3; // matches the printed photo box shape (see CRM_BACKEND's renderer.js photo section)
const COMPRESS_MAX_DIM = 1600;
const COMPRESS_QUALITY = 0.85;

export const fileToDataUri = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });

// Crops to the selected pixel region, downsizes so the long edge is at most
// COMPRESS_MAX_DIM, and re-encodes as JPEG — keeps even a 15-20MB camera
// photo down to a few hundred KB regardless of the original format/size.
export async function cropAndCompress(imageSrc, cropPixels) {
  const img = await loadImage(imageSrc);
  const { x, y, width, height } = cropPixels;
  let outW = width;
  let outH = height;
  if (Math.max(outW, outH) > COMPRESS_MAX_DIM) {
    const scale = COMPRESS_MAX_DIM / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, width, height, 0, 0, outW, outH);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))), 'image/jpeg', COMPRESS_QUALITY);
  });
  return fileToDataUri(blob);
}

export function ImageUploadCard({ label, hint, value, onSelect, onClear, heightCls = 'h-40' }) {
  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      <div className={`relative rounded-lg border-2 border-dashed bg-gray-50 ${heightCls} flex items-center justify-center overflow-hidden ${value ? 'border-gray-200' : 'border-gray-300'}`}>
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
          <div className="flex items-center gap-5 text-gray-400">
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

// Drag-to-crop + pinch-zoom overlay shown after a file is picked, before it's
// attached to the form. Crops to CROP_ASPECT then hands the result to onApply
// as a compressed JPEG data URI (see cropAndCompress).
export function CropModal({ imageSrc, onCancel, onApply }) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [busy, setBusy] = useState(false);
  const { notifyError } = useNotify();

  const handleCropComplete = useCallback((_area, pixels) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleApply = async () => {
    if (!croppedAreaPixels) return;
    setBusy(true);
    try {
      const dataUri = await cropAndCompress(imageSrc, croppedAreaPixels);
      onApply(dataUri);
    } catch {
      notifyError('Failed to process image. Please try a different photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onRequestClose={onCancel}
      overlayClassName="fixed inset-0 bg-gray-900 bg-opacity-70 flex items-center justify-center z-[60] p-4"
      className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-auto outline-none"
      contentLabel="Crop Image"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h3 className="text-base font-semibold text-gray-800">Adjust photo</h3>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <div className="relative bg-gray-900" style={{ height: 320 }}>
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={CROP_ASPECT}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={handleCropComplete}
        />
      </div>
      <div className="px-5 py-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Zoom</label>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={busy || !croppedAreaPixels}
            className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
          >
            {busy ? 'Processing...' : 'Apply'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx eslint src/utils/pdiImageUpload.jsx
```
Expected: clean. This project's ESLint config uses `react/jsx-runtime` — no default `import React from 'react'` is needed or wanted here.

- [ ] **Step 3: Commit**

```bash
git add src/utils/pdiImageUpload.jsx
git commit -m "feat: extract shared PDI image crop/upload utilities for the generic fill-out form"
```

---

### Task 3: Frontend — the generic fill-out form component

**Files:**
- Create: `CRM/src/components/admin/GenericPdiGeneratorForm.jsx`

This is the largest, highest-risk piece: a form that renders correctly for *any* template definition by walking `definition.pages → sections`. Read "Before you start" at the top of this plan again before writing `handleSave`/`handleFinalize` — the `const { photos, ...data } = form;` destructuring is load-bearing, not optional style.

- [ ] **Step 1: Write the component**

```jsx
// CRM/src/components/admin/GenericPdiGeneratorForm.jsx
import { useState, useRef, useCallback, useEffect, Fragment } from 'react';
import Modal from 'react-modal';
import axios from 'axios';
import { useParams, useSearchParams } from 'react-router-dom';
import { Download, FileText, Plus, Trash2 } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';
import { ImageUploadCard, CropModal, fileToDataUri, MAX_RAW_IMAGE_BYTES } from '../../utils/pdiImageUpload';

const API_URL = import.meta.env.VITE_BACKEND_URL || '';

const INPUT_CLS =
  'w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400';
const SELECT_CLS =
  'border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400';
const TH_CLS = 'py-2 px-2 text-xs font-semibold text-gray-700 bg-amber-100 border border-gray-200 whitespace-nowrap';

const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

// Builds a blank form-data object covering every dataKey/role the definition
// references, mirroring CRM_BACKEND's own buildSampleData (same walk, but
// blank values instead of sample placeholder text, since this is a genuinely
// empty new draft, not a PDF preview).
function buildDefaultFormData(definition) {
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

function makeEmptyRow(columns) {
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
          className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 text-xs font-medium"
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
                {cols.map((c) => (
                  <td key={c.key} className="py-1 px-1 border border-gray-100">
                    {(!c.cell || c.cell.source === 'row') ? (
                      <input className={INPUT_CLS} value={row[c.key] || ''} onChange={(e) => setCell(section.dataKey, idx, c.key, e.target.value)} />
                    ) : (
                      <span className="text-sm text-gray-400 px-2">—</span>
                    )}
                  </td>
                ))}
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
                        <select className={SELECT_CLS} value={value} onChange={(e) => setCell(section.dataKey, row.key, c.cell.subfield, e.target.value)}>
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
          className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 text-xs font-medium"
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

function renderSection(section, ctx) {
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

export default function GenericPdiGeneratorForm() {
  const { templateId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { notifySuccess, notifyError } = useNotify();

  const [definition, setDefinition] = useState(null);
  const [templateName, setTemplateName] = useState('');
  const [loadError, setLoadError] = useState(null);

  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [form, setForm] = useState(null);
  const [reportId, setReportId] = useState(null);
  const [hasSaved, setHasSaved] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Fetch the template definition once on mount.
  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('token');
      if (!token) { notifyError('Please log in first.'); return; }
      try {
        const response = await axios.get(`${API_URL}/api/pdi/templates/${templateId}/definition`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setDefinition(response.data.definition);
        setTemplateName(response.data.name);
      } catch (err) {
        setLoadError(err.response?.data?.error || 'Could not load this PDI template.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // Resume: if the dashboard linked here with ?report=<id>, load that report
  // and open pre-filled instead of waiting for the card click. Only runs once
  // the definition has loaded, since building the merged form needs it.
  useEffect(() => {
    if (!definition) return;
    const resumeId = searchParams.get('report');
    if (!resumeId) return;

    (async () => {
      const token = localStorage.getItem('token');
      if (!token) { notifyError('Please log in first.'); setSearchParams({}, { replace: true }); return; }
      try {
        const response = await axios.get(`${API_URL}/api/pdi/reports/${resumeId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const report = response.data;
        const base = buildDefaultFormData(definition);
        const reportPhotos = report.photos;
        const hasRealPhotos = reportPhotos && (Array.isArray(reportPhotos) ? reportPhotos.length > 0 : Object.keys(reportPhotos).length > 0);
        setForm({
          ...base,
          ...(report.data || {}),
          photos: hasRealPhotos ? reportPhotos : base.photos,
        });
        setReportId(report.report_id);
        setHasSaved(true);
        setActiveTab(0);
        setIsOpen(true);
      } catch (err) {
        notifyError(err.response?.data?.error || 'Could not load that PDI report.');
      } finally {
        setSearchParams({}, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition]);

  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const addRepeatableRow = useCallback((dataKey, columns) => {
    setForm((prev) => ({ ...prev, [dataKey]: [...(prev[dataKey] || []), makeEmptyRow(columns)] }));
  }, []);
  const removeRepeatableRow = useCallback((dataKey, idx) => {
    setForm((prev) => ({ ...prev, [dataKey]: prev[dataKey].filter((_, i) => i !== idx) }));
  }, []);
  const setRepeatableCell = useCallback((dataKey, idx, colKey, value) => {
    setForm((prev) => {
      const rows = [...(prev[dataKey] || [])];
      rows[idx] = { ...rows[idx], [colKey]: value };
      return { ...prev, [dataKey]: rows };
    });
  }, []);

  const setFixedCell = useCallback((dataKey, rowKey, subfield, value) => {
    setForm((prev) => ({
      ...prev,
      [dataKey]: { ...prev[dataKey], [rowKey]: { ...prev[dataKey][rowKey], [subfield]: value } },
    }));
  }, []);

  const addFreeformPhoto = useCallback((dataKey) => {
    setForm((prev) => ({ ...prev, [dataKey]: [...(prev[dataKey] || []), { label: '', image: null }] }));
  }, []);
  const removeFreeformPhoto = useCallback((dataKey, idx) => {
    setForm((prev) => ({ ...prev, [dataKey]: prev[dataKey].filter((_, i) => i !== idx) }));
  }, []);
  const setFreeformPhotoLabel = useCallback((dataKey, idx, label) => {
    setForm((prev) => {
      const list = [...prev[dataKey]];
      list[idx] = { ...list[idx], label };
      return { ...prev, [dataKey]: list };
    });
  }, []);
  const setFreeformPhotoImage = useCallback((dataKey, idx, image) => {
    setForm((prev) => {
      const list = [...prev[dataKey]];
      list[idx] = { ...list[idx], image };
      return { ...prev, [dataKey]: list };
    });
  }, []);

  const setFixedSlotImage = useCallback((dataKey, slotKey, image) => {
    setForm((prev) => ({ ...prev, [dataKey]: { ...prev[dataKey], [slotKey]: image } }));
  }, []);

  const setImageField = useCallback((dataKey, image) => {
    setForm((prev) => ({ ...prev, [dataKey]: image }));
  }, []);

  const [cropTarget, setCropTarget] = useState(null); // { apply: (dataUri) => void, imageSrc } | null

  const handleFileChosen = useCallback(async (applyFn, file, inputEl) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notifyError('Please choose an image file.');
      if (inputEl) inputEl.value = '';
      return;
    }
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      notifyError(`Image is too large (max ${(MAX_RAW_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
      if (inputEl) inputEl.value = '';
      return;
    }
    try {
      const dataUri = await fileToDataUri(file);
      setCropTarget({ apply: applyFn, imageSrc: dataUri });
    } catch {
      notifyError('Failed to read image file.');
    } finally {
      if (inputEl) inputEl.value = '';
    }
  }, [notifyError]);

  const applyCroppedImage = useCallback((dataUri) => {
    setCropTarget((current) => {
      if (!current) return current;
      current.apply(dataUri);
      return null;
    });
  }, []);
  const cancelCrop = useCallback(() => setCropTarget(null), []);

  const handleOpen = async () => {
    if (opening || !definition) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setOpening(true);
    try {
      const response = await axios.post(`${API_URL}/api/pdi/reports`, { template_id: templateId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setReportId(response.data.report_id);
      setHasSaved(false);
      setForm(buildDefaultFormData(definition));
      setActiveTab(0);
      setIsOpen(true);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not start a new PDI report.');
    } finally {
      setOpening(false);
    }
  };

  // Combines every signature role's value (in the template's own role order)
  // into one string, matching AutoNXTGeneratorForm's pattern generalized to
  // however many roles a given template happens to define.
  const inspectedByValue = () => {
    const roleKeys = [];
    definition.pages.forEach((page) => page.sections.forEach((s) => {
      if (s.type === 'signature') s.roles.forEach((r) => roleKeys.push(r.key));
    }));
    const names = roleKeys.map((k) => (form[k] || '').trim()).filter(Boolean);
    return names.length ? names.join(' / ') : undefined;
  };

  const handleSave = async () => {
    if (!reportId) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    try {
      // See "Before you start" at the top of this plan — this destructuring
      // is load-bearing, not optional style. Do not send `photos` inside `data`.
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, {
        data, photos, status: 'In Progress', inspected_by: inspectedByValue(),
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setHasSaved(true);
      notifySuccess('Progress saved.');
    } catch (err) {
      notifyError(err.response?.data?.error || 'Failed to save progress.');
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async (e) => {
    e.preventDefault();
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    if (!reportId) { notifyError('Report not initialized yet — please close and reopen the form.'); return; }

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

  const handleClose = async () => {
    if (abortRef.current) abortRef.current.abort();
    if (reportId && !hasSaved) {
      try {
        const token = localStorage.getItem('token');
        await axios.delete(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.error('Failed to clean up unsaved PDI draft:', err);
      }
    }
    setIsOpen(false);
    setReportId(null);
    setHasSaved(false);
  };

  if (loadError) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">{loadError}</div>;
  }
  if (!definition) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading template...</div>;
  }

  const ctx = form ? {
    form, setField, addRepeatableRow, removeRepeatableRow, setRepeatableCell, setFixedCell,
    addFreeformPhoto, removeFreeformPhoto, setFreeformPhotoLabel, setFreeformPhotoImage,
    setFixedSlotImage, setImageField, handleFileChosen,
  } : null;

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

      <Modal
        isOpen={isOpen && !!form}
        onRequestClose={handleClose}
        overlayClassName="fixed inset-0 bg-gray-900 bg-opacity-60 flex items-start justify-center z-50 overflow-y-auto py-8"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl mx-4 outline-none"
        contentLabel={templateName}
      >
        {form && (
          <form onSubmit={handleFinalize}>
            <div className="flex items-center justify-between px-8 py-5 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <FileText className="text-amber-500" size={24} />
                <h2 className="text-xl font-bold text-gray-800">{templateName}</h2>
              </div>
              <button type="button" onClick={handleClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>

            <div className="px-8 py-6 space-y-6 max-h-[80vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PDI No. <span className="text-red-500">*</span></label>
                <input className={INPUT_CLS} value={form.pdi_no} onChange={(e) => setField('pdi_no', e.target.value)} placeholder="e.g. PDI-2026-001" />
              </div>

              {definition.pages.length > 1 && (
                <div className="border-b border-gray-200">
                  <nav className="flex gap-1">
                    {definition.pages.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setActiveTab(i)}
                        className={`px-5 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                          activeTab === i
                            ? 'border-amber-500 text-amber-600 bg-amber-50'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        Page {i + 1}
                      </button>
                    ))}
                  </nav>
                </div>
              )}

              {definition.pages[activeTab]?.sections.map((section, i) => (
                <div key={i}>{renderSection(section, ctx)}</div>
              ))}
            </div>

            <div className="flex justify-between gap-3 px-8 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading}
                className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 text-sm font-semibold"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <div className="flex gap-3">
                <button type="button" onClick={handleClose} className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 text-sm">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
                >
                  <Download size={16} />
                  {loading ? 'Finalizing...' : 'Finalize & Generate PDF'}
                </button>
              </div>
            </div>
          </form>
        )}
      </Modal>

      {cropTarget && (
        <CropModal imageSrc={cropTarget.imageSrc} onCancel={cancelCrop} onApply={applyCroppedImage} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx eslint src/components/admin/GenericPdiGeneratorForm.jsx
npm run build
```
Both must be clean (the pre-existing >500kB chunk-size build warning is expected and fine).

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/GenericPdiGeneratorForm.jsx
git commit -m "feat: add generic fill-out form for admin-authored PDI templates"
```

---

### Task 4: Frontend — routing

**Files:**
- Modify: `CRM/src/routeConfig.jsx`
- Modify: `CRM/src/constants.js`

`PdiTemplatePicker.jsx` and `PdiReportsTable.jsx`'s Resume action already navigate to `/pdi-generator/<id>` generically — neither needs any change.

- [ ] **Step 1: Add the route**

In `CRM/src/routeConfig.jsx`, add the import near the other `./components/admin/...` imports:
```js
import GenericPdiGeneratorForm from "./components/admin/GenericPdiGeneratorForm";
```
Add a new route immediately after the existing `/pdi-generator/autonxt` entry:
```js
{
  path: "/pdi-generator/:templateId",
  allowedRoles: ["admin", "production"],
  component: GenericPdiGeneratorForm,
},
```
React Router ranks static path segments (`/pdi-generator/general`, `/pdi-generator/autonxt`) above a dynamic one (`/pdi-generator/:templateId`) regardless of registration order, so this is purely additive — General and AutoNXT keep resolving to their own components.

- [ ] **Step 2: Update the role-path allowlist**

`CRM/src/constants.js`'s `allowedPathsByRole` has a second, independent guard mechanism from `routeConfig.jsx` (checked in `App.jsx`) — a path containing `:` is matched as a pattern rather than an exact string (confirmed by an earlier task in this same project). Add `/pdi-generator/:templateId` to **both** the `admin` and `production` role arrays, alongside the existing `/pdi-generator/general`/`/pdi-generator/autonxt` entries (matching that same comment reminding future readers that new PDI routes need adding here too, per role).

- [ ] **Step 3: Verify**

```bash
npx eslint src/routeConfig.jsx src/constants.js
npm run build
```
Both must be clean.

- [ ] **Step 4: Commit**

```bash
git add src/routeConfig.jsx src/constants.js
git commit -m "feat: route admin-authored PDI templates to the generic fill-out form"
```

---

### Task 5: Full-stack live verification

Not a subagent task — the controller (you, continuing this session) does this personally, mirroring exactly how Phase 1's General re-expression and Phase 2's version-pinning guarantee were personally verified live before shipping, using the `gstack` skill.

Walk through, end to end:
1. Start both dev servers (`FRONTEND_URL=http://localhost:5173 npm run dev` in CRM_BACKEND, `npm run dev` in CRM — the CRM_BACKEND `.env`'s `FRONTEND_URL` points at production and must be overridden this way for local CORS, per this session's established pattern; never edit `.env` itself for this).
2. As an admin, author a new template through `/pdi-templates` covering all 6 section types on at least 2 pages (a `header` with at least one text and one date field, a `repeatable` table, a `fixed` table with at least one `sectionData`-sourced column, a `freeform` photo section, an `image` section, a `signature` section with 2+ roles, a `text` section) — reuse the "Before you start" note's guidance and give the photo/image section(s) whatever dataKey you like, including deliberately testing one named exactly `photos` to prove the destructuring contract holds.
3. Save & Publish it.
4. Open `/pdi-generator`, confirm the new template now appears in the picker alongside General and AutoNXT, and select it.
5. Confirm the generic form renders every section correctly: read-only vs. editable table cells in the right places, add/remove working on the repeatable table and freeform photos, image upload working (crop modal appears, applies).
6. Fill in a PDI No. and a few other fields, click Save, confirm a success toast and that the report was actually created (`POST /api/pdi/reports` then `PATCH`).
7. Reload the page and use the dashboard's Resume action (or navigate directly to `/pdi-generator/<templateId>?report=<id>`) — confirm the form reopens pre-filled with everything you entered, including the uploaded image(s).
8. Click Finalize & Generate PDF — confirm a PDF downloads, and use the Read tool on the downloaded PDF to confirm its actual content matches what was entered (not just that a PDF byte-stream came back).
9. Test Cancel on a fresh, never-saved draft — confirm via a direct DB query that the draft report was deleted, matching the established pattern.
10. Clean up all test data created during this walkthrough (template, reports, any test user) the same way every prior live-verification pass in this session has.

Report back what was verified, any issues found and fixed, and confirm both repos are ready to push.
