# PDI Template Authoring UI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define a new PDI PDF template (sections, columns, fields) through a web UI and database, without writing code — while General and AutoNXT stay exactly as they are today.

**Architecture:** A new `pdi_templates` table stores versioned JSON definitions (append-only — every save is a new version, so editing a template never changes how an already-created report renders). A small adapter (`authoredTemplate.js`) turns that JSON into the exact in-memory shape Phase 1's `renderTemplate` already knows how to draw — zero changes to `renderer.js`. Admin CRUD/publish/archive/preview endpoints sit behind a `role_id === 1` check. A single admin page (list + editor) drives it from the frontend.

**Tech Stack:** Node/Express, PostgreSQL (JSONB), PDFKit (via the existing Phase 1 renderer), React.

**Reference:** `docs/superpowers/specs/2026-09-08-pdi-template-authoring-design.md`

---

## Before you start

Read `docs/superpowers/specs/2026-09-08-pdi-template-authoring-design.md` in full — it defines the exact declarative dialect (header/table/photo/image/signature/text field names) this plan implements verbatim. Also read the current `models/operations/pdi/templates/general.js` and `models/operations/pdi/renderer.js` if you want to see the in-memory shape the adapter must produce — you don't strictly need to, since this plan gives you the exact code, but it may help you sanity-check.

---

### Task 1: Database migration

**Files:**
- Create: `scripts/migrations/2026-09-08-add-pdi-templates.js`

- [ ] **Step 1: Write the migration**

```js
// scripts/migrations/2026-09-08-add-pdi-templates.js
require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS pdi_templates (
      id          TEXT NOT NULL,
      version     INT NOT NULL,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
      definition  JSONB NOT NULL,
      created_by  INT REFERENCES users(user_id),
      created_at  TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (id, version)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pdi_templates_id_version ON pdi_templates (id, version DESC)`,
    `ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS template_version INT`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `node scripts/migrations/2026-09-08-add-pdi-templates.js`
Expected: prints each `Running:` line then `Migration complete.`, exit code 0.

- [ ] **Step 3: Verify the schema**

Run:
```bash
node -e "
require('dotenv').config();
const pool = require('./config/db');
(async () => {
  const t = await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='pdi_templates' ORDER BY ordinal_position\");
  console.log('pdi_templates columns:', t.rows.map(r => r.column_name).join(', '));
  const r = await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='pre_dispatch_inspection_reports' AND column_name='template_version'\");
  console.log('template_version present:', r.rows.length === 1);
  await pool.end();
})();
"
```
Expected: `pdi_templates columns: id, version, name, status, definition, created_by, created_at` and `template_version present: true`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/2026-09-08-add-pdi-templates.js
git commit -m "feat: add pdi_templates table and template_version column"
```

---

### Task 2: AuthoredTemplates data-access model

**Files:**
- Create: `models/operations/pdi/authoredTemplates.js`
- Test: `tests/pdi_authored_templates.test.js`

This is a plain SQL data-access layer over the `pdi_templates` table — no PDF logic here at all.

- [ ] **Step 1: Write the model**

```js
// models/operations/pdi/authoredTemplates.js
'use strict';

const pool = require('../../../config/db');

class AuthoredTemplates {
  static async create({ id, name, definition, createdBy }) {
    const result = await pool.query(`
      INSERT INTO pdi_templates (id, version, name, status, definition, created_by)
      VALUES ($1, 1, $2, 'draft', $3, $4)
      RETURNING *
    `, [id, name, JSON.stringify(definition), createdBy || null]);
    return result.rows[0];
  }

  static async getLatest(id) {
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 ORDER BY version DESC LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async getByVersion(id, version) {
    if (version == null) return null;
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 AND version = $2`,
      [id, version]
    );
    return result.rows[0] || null;
  }

  static async getActive(id) {
    const result = await pool.query(
      `SELECT * FROM pdi_templates WHERE id = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  // One row per id, its latest ACTIVE version — for the public template picker.
  static async listActive() {
    const result = await pool.query(`
      SELECT DISTINCT ON (id) id, name, version
      FROM pdi_templates
      WHERE status = 'active'
      ORDER BY id, version DESC
    `);
    return result.rows;
  }

  // One row per id, its latest version regardless of status — for the admin list page.
  static async listAll() {
    const result = await pool.query(`
      SELECT DISTINCT ON (id) id, name, version, status, created_at
      FROM pdi_templates
      ORDER BY id, version DESC
    `);
    return result.rows;
  }

  static async idExists(id) {
    const result = await pool.query(`SELECT 1 FROM pdi_templates WHERE id = $1 LIMIT 1`, [id]);
    return result.rows.length > 0;
  }

  // Append-only save: always inserts a new version row. `name`/`definition`/`status`
  // default to the latest version's values when omitted, so callers can bump just
  // one field (e.g. publish only changes status) without resending everything.
  static async saveNewVersion(id, { name, definition, status } = {}) {
    const latest = await this.getLatest(id);
    if (!latest) throw new Error('Template not found');
    const nextVersion = latest.version + 1;
    const result = await pool.query(`
      INSERT INTO pdi_templates (id, version, name, status, definition, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      id,
      nextVersion,
      name ?? latest.name,
      status ?? latest.status,
      JSON.stringify(definition ?? latest.definition),
      latest.created_by,
    ]);
    return result.rows[0];
  }
}

module.exports = AuthoredTemplates;
```

- [ ] **Step 2: Write tests**

```js
// tests/pdi_authored_templates.test.js
const pool = require('../config/db');
const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');

const TEST_ID = 'test-template-' + Date.now();

describe('AuthoredTemplates', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM pdi_templates WHERE id = $1', [TEST_ID]);
    await pool.end();
  });

  it('creates version 1 as a draft', async () => {
    const row = await AuthoredTemplates.create({ id: TEST_ID, name: 'Test Template', definition: { pages: [] } });
    expect(row.version).toBe(1);
    expect(row.status).toBe('draft');
    expect(row.name).toBe('Test Template');
  });

  it('idExists is true after creation, false for an unrelated id', async () => {
    expect(await AuthoredTemplates.idExists(TEST_ID)).toBe(true);
    expect(await AuthoredTemplates.idExists('definitely-not-a-real-id')).toBe(false);
  });

  it('saveNewVersion appends a new row rather than mutating the existing one', async () => {
    const v2 = await AuthoredTemplates.saveNewVersion(TEST_ID, { definition: { pages: [{ sections: [] }] } });
    expect(v2.version).toBe(2);
    const v1 = await AuthoredTemplates.getByVersion(TEST_ID, 1);
    expect(v1.definition).toEqual({ pages: [] });
    expect(v1.version).toBe(1);
  });

  it('getLatest returns the highest version', async () => {
    const latest = await AuthoredTemplates.getLatest(TEST_ID);
    expect(latest.version).toBe(2);
  });

  it('publishing (status only) still creates a new version, preserving the definition', async () => {
    const published = await AuthoredTemplates.saveNewVersion(TEST_ID, { status: 'active' });
    expect(published.version).toBe(3);
    expect(published.status).toBe('active');
    expect(published.definition).toEqual({ pages: [{ sections: [] }] });
  });

  it('getActive finds the published version', async () => {
    const active = await AuthoredTemplates.getActive(TEST_ID);
    expect(active.version).toBe(3);
  });

  it('archiving hides it from listActive but old versions stay resolvable by exact version', async () => {
    await AuthoredTemplates.saveNewVersion(TEST_ID, { status: 'archived' });
    const activeList = await AuthoredTemplates.listActive();
    expect(activeList.find((t) => t.id === TEST_ID)).toBeUndefined();
    const stillThere = await AuthoredTemplates.getByVersion(TEST_ID, 3);
    expect(stillThere.status).toBe('active'); // the exact historical row, unaffected by the later archive
  });

  it('listAll shows the latest version regardless of status', async () => {
    const all = await AuthoredTemplates.listAll();
    const mine = all.find((t) => t.id === TEST_ID);
    expect(mine.version).toBe(4);
    expect(mine.status).toBe('archived');
  });

  it('getByVersion returns null when version is null/undefined (defensive — never guesses "latest")', async () => {
    expect(await AuthoredTemplates.getByVersion(TEST_ID, null)).toBeNull();
    expect(await AuthoredTemplates.getByVersion(TEST_ID, undefined)).toBeNull();
  });

  it('saveNewVersion throws a clear error for an unknown id', async () => {
    await expect(AuthoredTemplates.saveNewVersion('no-such-template-id')).rejects.toThrow('Template not found');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/pdi_authored_templates.test.js --forceExit`
Expected: PASS (10/10)

- [ ] **Step 4: Commit**

```bash
git add models/operations/pdi/authoredTemplates.js
git add -f tests/pdi_authored_templates.test.js
git commit -m "feat: add AuthoredTemplates data-access model for versioned DB-backed PDI templates"
```

Note: this repo's `.gitignore` has a broad `*.test.js` rule — use `git add -f` for test files (known, pre-existing repo quirk).

---

### Task 3: The declarative-to-hydrated adapter

**Files:**
- Create: `models/operations/pdi/authoredTemplate.js`
- Test: `tests/pdi_authored_template_adapter.test.js`

This is the heart of Phase 2: it takes a JSON definition (the dialect from the spec) and produces the exact shape `renderer.js`'s `renderTemplate` already consumes — real functions plugged in for `value`, `fixedRows`, `filterRow`, `placeholder.text`, and a computed `footerHeight`. **`renderer.js` itself is not modified by this task or any task in this plan.**

- [ ] **Step 1: Write the adapter**

```js
// models/operations/pdi/authoredTemplate.js
'use strict';

const TEXT_H = 40;   // matches renderer.js's own TEXT_H — see note below
const SIG_H = 36;    // matches renderer.js's own SIG_H
const FALLBACK_BUFFER = 150; // heuristic reserve when a section's height can't be known in advance

/** Turn one declarative column's `cell` spec into the `value(row, sectionData)`
 *  function renderer.js's table drawer expects. Exactly the three shapes the
 *  design spec allows — nothing else is representable in an authored template. */
function hydrateCell(cell) {
  if (!cell || cell.source === 'row') {
    return undefined; // renderer.js's own fallback is `row[col.key] ?? ''` — no override needed
  }
  if (cell.source === 'sectionData') {
    const { subfield, default: def } = cell;
    return (row, sectionData) => (sectionData[row.key] || {})[subfield] || def || '';
  }
  if (cell.source === 'constant') {
    const { value } = cell;
    return () => value;
  }
  throw new Error(`Unknown cell source: ${cell.source}`);
}

function hydrateColumns(columns) {
  return columns.map((c) => ({
    key: c.key, label: c.label, w: c.w, align: c.align, group: c.group,
    value: hydrateCell(c.cell),
  }));
}

/** Estimate a section's rendered height without any per-report data, for the
 *  automatic footerHeight calculation below. Sections whose height genuinely
 *  depends on data content (photo, image, or a second repeatable table)
 *  return null — the caller falls back to a fixed safety buffer instead of
 *  guessing wrong and corrupting layout. */
function staticHeight(section) {
  if (section.type === 'text') return TEXT_H + (section.gap || 0);
  if (section.type === 'signature') return SIG_H + (section.gap || 0);
  if (section.type === 'table' && section.mode === 'fixed') {
    const rows = (section.fixedRows || []).length;
    return section.headerHeight + rows * section.rowHeight + (section.gap || 0);
  }
  return null;
}

/** Sum the known heights of every section after `index` on the same page;
 *  fall back to a fixed buffer the moment one has unknowable height, since
 *  guessing under-reserves and orphans content, while over-reserving by a
 *  flat buffer only costs an earlier-than-strictly-necessary page break. */
function computeFooterHeight(sections, index) {
  let total = 0;
  for (let i = index + 1; i < sections.length; i++) {
    const h = staticHeight(sections[i]);
    if (h == null) return total + FALLBACK_BUFFER;
    total += h;
  }
  return total;
}

function hydrateTableSection(section, sections, index) {
  const hydrated = {
    type: 'table',
    title: section.title || undefined,
    mode: section.mode,
    dataKey: section.dataKey,
    columns: hydrateColumns(section.columns),
    headerHeight: section.headerHeight,
    rowHeight: section.rowHeight,
    gap: section.gap,
  };
  if (section.mode === 'fixed') {
    const rows = section.fixedRows || [];
    hydrated.fixedRows = () => rows;
  } else {
    if (section.filterKey) {
      const key = section.filterKey;
      hydrated.filterRow = (row) => !!(row && String(row[key] || '').trim());
    }
    hydrated.footerHeight = () => computeFooterHeight(sections, index);
  }
  return hydrated;
}

function hydrateImageSection(section) {
  const hydrated = {
    type: 'image',
    dataKey: section.dataKey,
    width: section.width,
    height: section.height,
    title: section.title || undefined,
    gap: section.gap,
  };
  if (section.placeholder) {
    const text = section.placeholder.text || '';
    hydrated.placeholder = {
      text: () => text,
      annotations: section.placeholder.annotations || [],
    };
  }
  return hydrated;
}

function hydrateHeaderSection(section) {
  return {
    type: 'header',
    companyName: section.companyName,
    formatNo: section.formatNo,
    revNo: section.revNo,
    effDate: section.effDate,
    extraFormatLines: section.extraFormatLines,
    logoAsset: section.logoAsset,
    rLabelW: section.rLabelW,
    gap: section.gap,
    infoFields: section.infoFields.map((f) => [
      f.leftLabel,
      f.leftFormat === 'date'
        ? (data) => (data[f.leftKey] ? require('./primitives').fmtDate(new Date(data[f.leftKey])) : '')
        : (data) => data[f.leftKey] || '',
      f.rightLabel,
      f.rightFormat === 'date'
        ? (data) => (data[f.rightKey] ? require('./primitives').fmtDate(new Date(data[f.rightKey])) : '')
        : (data) => data[f.rightKey] || '',
    ]),
  };
}

/** Sections needing no transformation at all — already fully declarative in
 *  Phase 1 (photo, signature, text never used closures to begin with). */
function passthroughSection(section) {
  return { ...section };
}

function hydrateSection(section, sections, index) {
  switch (section.type) {
    case 'header': return hydrateHeaderSection(section);
    case 'table': return hydrateTableSection(section, sections, index);
    case 'image': return hydrateImageSection(section);
    case 'photo':
    case 'signature':
    case 'text':
      return passthroughSection(section);
    default:
      throw new Error(`Unknown PDI template section type: ${section.type}`);
  }
}

/** Turn a stored declarative `definition` into the shape renderTemplate expects. */
function hydrateTemplate(definition) {
  return {
    pages: definition.pages.map((page) => ({
      sections: page.sections.map((section, index) => hydrateSection(section, page.sections, index)),
    })),
  };
}

/** Synthesize plausible sample data for every dataKey/role/column the
 *  definition references, for the live-preview endpoint — a preview must
 *  work before the template is ever used on a real report, so it can't rely
 *  on any real report's data existing. */
function buildSampleData(definition) {
  const data = { pdi_no: 'PREVIEW-0000' };
  definition.pages.forEach((page) => {
    page.sections.forEach((section) => {
      if (section.type === 'header') {
        section.infoFields.forEach((f) => {
          if (f.leftKey && data[f.leftKey] === undefined) {
            data[f.leftKey] = f.leftFormat === 'date' ? new Date().toISOString().slice(0, 10) : 'Sample';
          }
          if (f.rightKey && data[f.rightKey] === undefined) {
            data[f.rightKey] = f.rightFormat === 'date' ? new Date().toISOString().slice(0, 10) : 'Sample';
          }
        });
      } else if (section.type === 'table') {
        if (section.mode === 'repeatable') {
          data[section.dataKey] = [1, 2].map((n) => {
            const row = { sno: n };
            section.columns.forEach((c) => {
              if (!c.cell || c.cell.source === 'row') row[c.key] = `Sample ${n}`;
            });
            if (section.filterKey) row[section.filterKey] = row[section.filterKey] || `Sample ${n}`;
            return row;
          });
        } else if (section.mode === 'fixed') {
          const sectionData = {};
          (section.fixedRows || []).forEach((row) => {
            section.columns.forEach((c) => {
              if (c.cell && c.cell.source === 'sectionData') {
                sectionData[row.key] = sectionData[row.key] || {};
                sectionData[row.key][c.cell.subfield] = c.cell.default || 'GO';
              }
            });
          });
          data[section.dataKey] = sectionData;
        }
      } else if (section.type === 'text') {
        data[section.dataKey] = section.default || 'Sample remarks';
      } else if (section.type === 'signature') {
        section.roles.forEach((r) => { data[r.key] = 'Sample Name'; });
      } else if (section.type === 'photo') {
        data[section.dataKey] = section.mode === 'fixed-slots' ? {} : [];
      }
      // 'image' sections: leave data[dataKey] undefined so the placeholder renders.
    });
  });
  return data;
}

module.exports = { hydrateTemplate, buildSampleData };
```

- [ ] **Step 2: Write tests**

```js
// tests/pdi_authored_template_adapter.test.js
const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('../models/operations/pdi/primitives');
const { renderTemplate } = require('../models/operations/pdi/renderer');
const { hydrateTemplate, buildSampleData } = require('../models/operations/pdi/authoredTemplate');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function renderDefinition(definition, data) {
  const hydrated = hydrateTemplate(definition);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 10, bottom: 0, left: M, right: M }, autoFirstPage: false, bufferPages: true });
  registerFonts(doc);
  renderTemplate(doc, hydrated, data);
  doc.end();
  return doc;
}

const SAMPLE_DEFINITION = {
  pages: [
    {
      sections: [
        {
          type: 'header', gap: 4,
          companyName: 'Test Co.', formatNo: 'F/1', revNo: '00', effDate: '01/01/2026',
          infoFields: [
            { leftLabel: 'Customer:', leftKey: 'customer_name', leftFormat: 'text', rightLabel: 'Date:', rightKey: 'date', rightFormat: 'date' },
          ],
        },
        {
          type: 'table', gap: 4,
          mode: 'repeatable', dataKey: 'rows', filterKey: 'sno',
          columns: [
            { key: 'sno', label: 'S.No', w: 30, align: 'center', cell: { source: 'row' } },
            { key: 'notes', label: 'Notes', align: 'left', cell: { source: 'row' } },
          ],
          headerHeight: 20, rowHeight: 14,
        },
        {
          type: 'table', gap: 4,
          mode: 'fixed', dataKey: 'checks',
          fixedRows: [{ key: 'check_a', label: 'Check A' }],
          columns: [
            { key: 'label', label: 'Check', w: 200, align: 'left', cell: { source: 'row' } },
            { key: 'spec', label: 'Spec', align: 'center', cell: { source: 'constant', value: 'Go/NG' } },
            { key: 'measured', label: 'Result', align: 'center', cell: { source: 'sectionData', subfield: 'measured', default: 'GO' } },
          ],
          headerHeight: 14, rowHeight: 14,
        },
        { type: 'text', gap: 4, label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        { type: 'signature', roles: [{ key: 'prepared_by', label: 'Prepared By' }] },
      ],
    },
    {
      sections: [
        { type: 'photo', mode: 'freeform', dataKey: 'photos' },
      ],
    },
  ],
};

describe('authored template adapter', () => {
  it('hydrates a declarative definition into something renderTemplate can draw', async () => {
    const data = {
      pdi_no: 'TEST-1', customer_name: 'Acme', date: '2026-01-05',
      rows: [{ sno: 1, notes: 'n1' }, { sno: 2, notes: 'n2' }],
      checks: { check_a: { measured: 'GO' } },
      remarks: 'All good', prepared_by: 'Alice',
      photos: [],
    };
    const doc = renderDefinition(SAMPLE_DEFINITION, data);
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('a "row"-sourced column falls back to plain row[key] lookup (undefined value fn)', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const repeatableTable = hydrated.pages[0].sections[1];
    expect(repeatableTable.columns[0].value).toBeUndefined();
  });

  it('a "constant"-sourced column always returns its fixed value regardless of row/data', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const fixedTable = hydrated.pages[0].sections[2];
    const specCol = fixedTable.columns[1];
    expect(specCol.value({ key: 'check_a' }, {})).toBe('Go/NG');
  });

  it('a "sectionData"-sourced column reads sectionData[row.key][subfield], falling back to its default', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const fixedTable = hydrated.pages[0].sections[2];
    const measuredCol = fixedTable.columns[2];
    expect(measuredCol.value({ key: 'check_a' }, { check_a: { measured: 'NG' } })).toBe('NG');
    expect(measuredCol.value({ key: 'check_a' }, {})).toBe('GO'); // default, no data supplied
  });

  it('computes footerHeight automatically from known-height sections that follow', () => {
    const hydrated = hydrateTemplate(SAMPLE_DEFINITION);
    const repeatableTable = hydrated.pages[0].sections[1];
    // fixed table (14 header + 1*14 row + 4 gap) + text (40 + 4 gap) + signature (36) = 112
    expect(repeatableTable.footerHeight()).toBe(112);
  });

  it('falls back to a fixed buffer when a following section has data-dependent height', () => {
    const definitionWithPhotoAfter = {
      pages: [{
        sections: [
          {
            type: 'table', mode: 'repeatable', dataKey: 'rows',
            columns: [{ key: 'sno', label: 'S.No', align: 'center', cell: { source: 'row' } }],
            headerHeight: 20, rowHeight: 14,
          },
          { type: 'photo', mode: 'freeform', dataKey: 'photos' },
        ],
      }],
    };
    const hydrated = hydrateTemplate(definitionWithPhotoAfter);
    expect(hydrated.pages[0].sections[0].footerHeight()).toBe(150);
  });

  it('throws a clear error for an unknown section type (same style as renderer.js)', () => {
    expect(() => hydrateTemplate({ pages: [{ sections: [{ type: 'bogus' }] }] }))
      .toThrow(/Unknown PDI template section type/);
  });

  it('buildSampleData synthesizes plausible data covering every dataKey the definition references, producing a valid preview PDF', async () => {
    const sample = buildSampleData(SAMPLE_DEFINITION);
    expect(sample.customer_name).toBeTruthy();
    expect(sample.date).toBeTruthy();
    expect(Array.isArray(sample.rows)).toBe(true);
    expect(sample.checks.check_a.measured).toBe('GO');
    expect(sample.remarks).toBeTruthy();
    expect(sample.prepared_by).toBeTruthy();
    expect(sample.photos).toEqual([]);

    const doc = renderDefinition(SAMPLE_DEFINITION, sample);
    const buf = await bufferPdf(doc);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/pdi_authored_template_adapter.test.js --forceExit`
Expected: PASS (8/8)

- [ ] **Step 4: Run the existing renderer/generator tests to confirm nothing about Phase 1 broke**

Run: `npx jest tests/pdi_template_renderer.test.js tests/pdi_generator.test.js tests/pdi_primitives.test.js --forceExit`
Expected: PASS (all) — this task didn't touch any of those files, this is just a checkpoint.

- [ ] **Step 5: Commit**

```bash
git add models/operations/pdi/authoredTemplate.js
git add -f tests/pdi_authored_template_adapter.test.js
git commit -m "feat: add declarative-to-hydrated adapter for authored PDI templates"
```

---

### Task 4: Wire template resolution through PDIGenerator and pdiReports

**Files:**
- Modify: `models/operations/pdi_generator.js` (full rewrite, shown below)
- Modify: `models/operations/pdiReports.js` (several call sites)
- Modify: `controllers/operations/pdiReports.controller.js` (`createReport`)
- Modify: `tests/pdi_generator.test.js` (signature change — 3 existing calls)
- Test: `tests/pdi_generator.test.js` (new cases, appended to the same file)

`PDIGenerator.generate` needs a DB lookup for non-code templates, which means it must become `async`. This is safe: the DB lookup happens *before* the `PDFDocument` is even constructed, so the existing concurrency invariant ("no `await` between `registerFonts(doc)` and `doc.end()`, since `F`/`FB` are shared module state") is untouched — the whole synchronous draw block still runs with no `await` inside it.

- [ ] **Step 1: Rewrite `pdi_generator.js`**

```js
// models/operations/pdi_generator.js
'use strict';

const PDFDocument = require('pdfkit');
const { registerFonts, M } = require('./pdi/primitives');
const { renderTemplate } = require('./pdi/renderer');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const { hydrateTemplate, buildSampleData } = require('./pdi/authoredTemplate');

// The actual synchronous draw — same PDFDocument construction and comment as
// before, just pulled out so both the DB-lookup path and the code-registry
// path (and the no-DB preview path) share one place that builds the doc.
function renderPdfDoc(template, data) {
  const doc = new PDFDocument({
    size: 'A4',
    // bottom:0 — every draw call uses explicit x/y and its own
    // PAGE_H/BOT_M-based overflow checks, never PDFKit's flowing layout.
    // A non-zero bottom margin would make PDFKit silently insert a blank
    // page after every page (see primitives.js drawPageNum's comment).
    margins: { top: 10, bottom: 0, left: M, right: M },
    autoFirstPage: false,
    bufferPages: true,
  });
  registerFonts(doc);
  renderTemplate(doc, template, data);
  doc.end();
  return doc;
}

class PDIGenerator {
  // templateVersion is only meaningful for DB-backed templates — pass null
  // for a code-registered template id (general, autonxt, ...).
  static async generate(templateId, templateVersion, data = {}) {
    if (!data.pdi_no) throw new Error('pdi_no required');

    const codeTemplate = templates[templateId];
    if (codeTemplate) return renderPdfDoc(codeTemplate, data);

    const row = await AuthoredTemplates.getByVersion(templateId, templateVersion);
    if (!row) throw new Error(`Unknown PDI template: ${templateId}`);
    return renderPdfDoc(hydrateTemplate(row.definition), data);
  }

  // No DB lookup, no pdi_no requirement — used by the admin preview endpoint
  // to render an in-progress (possibly unsaved) draft definition directly.
  static previewFromDefinition(definition, data) {
    return renderPdfDoc(hydrateTemplate(definition), data ?? buildSampleData(definition));
  }
}

module.exports = PDIGenerator;
```

- [ ] **Step 2: Update `pdiReports.js`'s two callers**

In `models/operations/pdiReports.js`, the `finalizeReport` method currently has:
```js
    const pdfBuffer = await bufferPdf(PDIGenerator.generate(report.template_id, { ...(report.data || {}), photos: report.photos || [] }));
```
Change to:
```js
    const pdfBuffer = await bufferPdf(await PDIGenerator.generate(report.template_id, report.template_version, { ...(report.data || {}), photos: report.photos || [] }));
```

The `getPdfBuffer` method currently has:
```js
  static async getPdfBuffer(reportId) {
    const report = await this.getById(reportId);
    return bufferPdf(PDIGenerator.generate(report.template_id, { ...(report.data || {}), photos: report.photos || [] }));
  }
```
Change to:
```js
  static async getPdfBuffer(reportId) {
    const report = await this.getById(reportId);
    return bufferPdf(await PDIGenerator.generate(report.template_id, report.template_version, { ...(report.data || {}), photos: report.photos || [] }));
  }
```

Also update `reportColumns()` (near the top of the file) to include the new column — it currently reads:
```js
function reportColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}drive_file_id,
    ${p}data, ${p}photos
  `;
}
```
Change to:
```js
function reportColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}template_version, ${p}drive_file_id,
    ${p}data, ${p}photos
  `;
}
```

And `#toPayload` (which maps a DB row to the API response shape) currently has:
```js
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      customer_id: row.customer_id,
      order_id: row.order_id,
      inspected_by: row.inspected_by,
      inspection_date: row.inspection_date,
      report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      drive_file_id: row.drive_file_id,
      data: row.data,
      photos: row.photos,
    };
  }
```
Add `template_version: row.template_version,` right after the `template_id` line.

Finally, `createReport`'s signature and INSERT need `template_version`. It currently reads:
```js
  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id }, io) {
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      template_id || 'general',
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
    ]);
```
Change to:
```js
  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id, template_version }, io) {
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, template_version, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      template_id || 'general',
      template_version ?? null,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
    ]);
```

- [ ] **Step 3: Update `createReport`'s controller to resolve `template_version`**

In `controllers/operations/pdiReports.controller.js`, `createReport` currently reads:
```js
exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos, template_id } = req.body || {};
    if (template_id !== undefined && !templates[template_id]) {
      return res.status(400).json({ error: `Unknown PDI template: ${template_id}` });
    }
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos,
      template_id: template_id || 'general',
    }, req.io);
```
Change to:
```js
exports.createReport = async (req, res) => {
  try {
    const { customer_id, order_id, inspected_by, inspection_date, data, photos, template_id } = req.body || {};
    const resolvedTemplateId = template_id || 'general';
    let templateVersion = null;
    if (!templates[resolvedTemplateId]) {
      const active = await AuthoredTemplates.getActive(resolvedTemplateId);
      if (!active) return res.status(400).json({ error: `Unknown PDI template: ${resolvedTemplateId}` });
      templateVersion = active.version;
    }
    const report = await PdiReports.createReport({
      customer_id, order_id, inspected_by: inspected_by || req.user.name, inspection_date, data, photos,
      template_id: resolvedTemplateId, template_version: templateVersion,
    }, req.io);
```

Add the import near the top of the file, alongside the existing `templates` require:
```js
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
```

- [ ] **Step 4: Fix the 3 existing calls in `tests/pdi_generator.test.js` for the new signature**

`PDIGenerator.generate` is now `async` and takes a `templateVersion` second argument. Update all 3 existing `it(...)` blocks in this file:
```js
// was: PDIGenerator.generate('general', {...})
await PDIGenerator.generate('general', null, {...})

// was: () => PDIGenerator.generate('does-not-exist', {...})
async () => { await PDIGenerator.generate('does-not-exist', null, {...}); }
// (and change expect(() => ...).toThrow(...) to await expect(...).rejects.toThrow(...))

// was: () => PDIGenerator.generate('general', {})
async () => { await PDIGenerator.generate('general', null, {}); }
// (same rejects.toThrow(...) change)
```
Read the current file in full first — it has grown across earlier tasks (general/autonxt smoke tests, the unknown-template-id error case, the registry-key/id invariant check) and every single `PDIGenerator.generate(...)` call site in it needs updating to the new `(templateId, templateVersion, data)` signature, with synchronous `expect(() => ...).toThrow(...)` assertions converted to `await expect(...).rejects.toThrow(...)`. Grep the file for `PDIGenerator.generate` to find every call site — don't rely on a specific count, just make sure none are missed.

- [ ] **Step 5: Add a new test proving DB-template resolution actually works end to end**

Append to `tests/pdi_generator.test.js`:
```js
  it('generates a valid PDF for a DB-backed (authored) template, resolved by id + version', async () => {
    const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');
    const pool = require('../config/db');
    const id = 'test-generate-authored-' + Date.now();
    const definition = {
      pages: [{
        sections: [
          { type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
        ],
      }],
    };
    const row = await AuthoredTemplates.create({ id, name: 'Test', definition });
    try {
      const buf = await bufferPdf(await PDIGenerator.generate(id, row.version, { pdi_no: 'X', remarks: 'All fine' }));
      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    } finally {
      await pool.query('DELETE FROM pdi_templates WHERE id = $1', [id]);
    }
  });

  it('throws for a DB template id that exists but at the wrong version', async () => {
    await expect(PDIGenerator.generate('some-authored-id', 999, { pdi_no: 'X' })).rejects.toThrow(/Unknown PDI template/);
  });
```

- [ ] **Step 6: Run the full PDI test suite**

Run: `npx jest tests/pdi_generator.test.js tests/pdi_template_renderer.test.js tests/pdi_primitives.test.js tests/pdi_authored_templates.test.js tests/pdi_authored_template_adapter.test.js --forceExit`
Expected: PASS (all)

Run: `npx jest tests/pdiReports.test.js --forceExit`
Expected: PASS (14/14) — unmodified file, this is the regression check that switching `generate` to async didn't break the live report-creation/finalize/download paths. This starts the full Express app and may leave a stray `node` process on port 8000 across separate test runs — if a later command hits `EADDRINUSE :::8000`, that's leftover from an earlier run in this session, not a real failure; find/kill via `netstat -ano | grep :8000` if it blocks you.

- [ ] **Step 7: Commit**

```bash
git add models/operations/pdi_generator.js models/operations/pdiReports.js controllers/operations/pdiReports.controller.js
git add -f tests/pdi_generator.test.js
git commit -m "feat: resolve PDI templates from either the code registry or the DB, pinned by version"
```

---

### Task 5: Admin API — CRUD, publish/archive, preview, and the public picker merge

**Files:**
- Create: `controllers/operations/pdi.admin.controller.js`
- Create: `routes/operations/pdiAdmin.js`
- Modify: `controllers/operations/pdi.controller.js` (`getTemplates` merge)
- Modify: `server.js` (mount the new route)
- Test: `tests/pdi_admin.test.js`

- [ ] **Step 1: Write the admin controller**

```js
// controllers/operations/pdi.admin.controller.js
'use strict';

const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');
const templates = require('../../models/operations/pdi/templates');
const PDIGenerator = require('../../models/operations/pdi_generator');
const logger = require('../../utils/logger');

function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function requireAdmin(req, res) {
  if (req.user.role_id !== 1) {
    res.status(403).json({ error: 'Admin only' });
    return false;
  }
  return true;
}

exports.listTemplates = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = await AuthoredTemplates.listAll();
    res.json(rows);
  } catch (error) {
    logger.error(`Error listing authored PDI templates: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getTemplate = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const row = await AuthoredTemplates.getLatest(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json(row);
  } catch (error) {
    logger.error(`Error fetching authored PDI template ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.createTemplate = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id, name, definition } = req.body || {};
    if (!id || !name || !definition) {
      return res.status(400).json({ error: 'id, name, and definition are required' });
    }
    if (templates[id]) {
      return res.status(409).json({ error: `Template id "${id}" is reserved by a built-in template` });
    }
    if (await AuthoredTemplates.idExists(id)) {
      return res.status(409).json({ error: `Template id "${id}" already exists` });
    }
    const row = await AuthoredTemplates.create({ id, name, definition, createdBy: req.user.user_id });
    logger.info(`Authored PDI template created: ${id} by ${req.user.user_id}`);
    res.status(201).json(row);
  } catch (error) {
    logger.error(`Error creating authored PDI template: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

async function saveWithStatus(req, res, statusOverride) {
  if (!requireAdmin(req, res)) return;
  try {
    const { name, definition } = req.body || {};
    const row = await AuthoredTemplates.saveNewVersion(req.params.id, {
      name, definition, status: statusOverride,
    });
    res.json(row);
  } catch (error) {
    if (error.message === 'Template not found') return res.status(404).json({ error: error.message });
    logger.error(`Error saving authored PDI template ${req.params.id}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

exports.saveTemplate = (req, res) => saveWithStatus(req, res, undefined);
exports.publishTemplate = (req, res) => saveWithStatus(req, res, 'active');
exports.archiveTemplate = (req, res) => saveWithStatus(req, res, 'archived');

exports.previewTemplate = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { definition } = req.body || {};
    if (!definition) return res.status(400).json({ error: 'definition is required' });
    const doc = PDIGenerator.previewFromDefinition(definition);
    const buf = await bufferPdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(buf);
  } catch (error) {
    // A malformed draft definition is a client error (bad section config),
    // not a server fault — surface the actual message so the editor can show it.
    res.status(400).json({ error: error.message });
  }
};
```

- [ ] **Step 2: Write the admin routes**

```js
// routes/operations/pdiAdmin.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.admin.controller');

router.get('/', authenticateToken, controller.listTemplates);
router.get('/:id', authenticateToken, controller.getTemplate);
router.post('/', authenticateToken, controller.createTemplate);
router.put('/:id', authenticateToken, controller.saveTemplate);
router.post('/:id/publish', authenticateToken, controller.publishTemplate);
router.post('/:id/archive', authenticateToken, controller.archiveTemplate);
router.post('/:id/preview', authenticateToken, controller.previewTemplate);

module.exports = router;
```

- [ ] **Step 3: Mount the route in `server.js`**

Find these two existing lines (search for `pdiReportsRoutes`):
```js
app.use('/api/pdi/reports', pdiReportsRoutes);
app.use('/api/pdi',         pdiRoutes);
```
Add the import near the top alongside the other `pdi*Routes` requires (search for `const pdiRoutes` to find the right spot):
```js
const pdiAdminRoutes         = require('./routes/operations/pdiAdmin');
```
And mount it **between** the two existing lines — more specific prefixes must be registered before the general `/api/pdi` catch-all, matching the existing comment right above these lines ("Order matters: /api/pdi/reports must be mounted before /api/pdi"):
```js
app.use('/api/pdi/reports', pdiReportsRoutes);
app.use('/api/pdi/admin/templates', pdiAdminRoutes);
app.use('/api/pdi',         pdiRoutes);
```

- [ ] **Step 4: Merge the public picker endpoint**

In `controllers/operations/pdi.controller.js`, currently:
```js
const templates = require('../../models/operations/pdi/templates');

exports.getTemplates = async (req, res) => {
  const list = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
  res.json(list);
};
```
Change to:
```js
const templates = require('../../models/operations/pdi/templates');
const AuthoredTemplates = require('../../models/operations/pdi/authoredTemplates');

exports.getTemplates = async (req, res) => {
  const codeList = Object.values(templates).map(({ id, name, version }) => ({ id, name, version }));
  const dbList = await AuthoredTemplates.listActive();
  res.json([...codeList, ...dbList]);
};
```

- [ ] **Step 5: Write tests**

```js
// tests/pdi_admin.test.js
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('PDI Admin Templates API', () => {
  let adminToken, adminUserId, nonAdminToken, nonAdminUserId;
  const createdIds = [];
  const createdReportIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['PDI Admin Test Admin', `pdi-admin-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const nonAdmin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 2) RETURNING user_id`,
      ['PDI Admin Test NonAdmin', `pdi-admin-test-nonadmin-${Date.now()}@example.com`]
    );
    nonAdminUserId = nonAdmin.rows[0].user_id;
    nonAdminToken = jwt.sign({ user_id: nonAdminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdReportIds.length) {
      await pool.query('DELETE FROM pre_dispatch_inspection_reports WHERE report_id = ANY($1::int[])', [createdReportIds]);
    }
    if (createdIds.length) {
      await pool.query('DELETE FROM pdi_templates WHERE id = ANY($1::text[])', [createdIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [adminUserId, nonAdminUserId]);
    await pool.end();
  });

  const SAMPLE_DEFINITION = {
    pages: [{
      sections: [
        { type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'OK' },
      ],
    }],
  };

  it('rejects a non-admin from creating a template', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .send({ id: 'nope', name: 'Nope', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(403);
  });

  it('creates a template as version 1, status draft', async () => {
    const id = 'admin-test-' + Date.now();
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Admin Test Template', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.status).toBe('draft');
    createdIds.push(id);
  });

  it('rejects creating a template whose id collides with a built-in template', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: 'general', name: 'Collision', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(409);
  });

  it('rejects creating a template whose id already exists', async () => {
    const id = 'admin-test-dup-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'First', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    const res = await request(app)
      .post('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Second', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(409);
  });

  it('saving an edit appends a new version rather than overwriting', async () => {
    const id = 'admin-test-edit-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Original', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    const res = await request(app)
      .put(`/api/pdi/admin/templates/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Edited', definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.name).toBe('Edited');
  });

  it('publishing sets status active and makes it appear in the public picker', async () => {
    const id = 'admin-test-publish-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Publish Me', definition: SAMPLE_DEFINITION });
    createdIds.push(id);

    const publishRes = await request(app)
      .post(`/api/pdi/admin/templates/${id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(publishRes.statusCode).toBe(200);
    expect(publishRes.body.status).toBe('active');

    const pickerRes = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pickerRes.body.some((t) => t.id === id)).toBe(true);
    expect(pickerRes.body.some((t) => t.id === 'general')).toBe(true); // code templates still present
  });

  it('archiving removes it from the public picker without deleting its history', async () => {
    const id = 'admin-test-archive-' + Date.now();
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Archive Me', definition: SAMPLE_DEFINITION });
    createdIds.push(id);
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);
    await request(app).post(`/api/pdi/admin/templates/${id}/archive`).set('Authorization', `Bearer ${adminToken}`);

    const pickerRes = await request(app)
      .get('/api/pdi/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pickerRes.body.some((t) => t.id === id)).toBe(false);

    const getRes = await request(app)
      .get(`/api/pdi/admin/templates/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.statusCode).toBe(200); // still fetchable by an admin, just not in the create-report picker
  });

  it('previews a definition without saving it, returning a valid PDF', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates/anything/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ definition: SAMPLE_DEFINITION });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('rejects previewing a malformed definition with a clear 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/pdi/admin/templates/anything/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ definition: { pages: [{ sections: [{ type: 'not-a-real-type' }] }] } });
    expect(res.statusCode).toBe(400);
  });

  it('lists all templates for the admin (any status), showing only the latest version', async () => {
    const res = await request(app)
      .get('/api/pdi/admin/templates')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a report created against a template version keeps rendering that exact version, even after the template is edited', async () => {
    const id = 'admin-test-pin-' + Date.now();
    const v1Definition = {
      pages: [{ sections: [{ type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'V1 TEXT' }] }],
    };
    await request(app).post('/api/pdi/admin/templates').set('Authorization', `Bearer ${adminToken}`)
      .send({ id, name: 'Pin Test', definition: v1Definition });
    createdIds.push(id);
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);

    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ template_id: id, data: { pdi_no: 'PIN-TEST-1', customer_name: 'Pin Co.', remarks: 'Report remarks' } });
    expect(created.statusCode).toBe(201);
    expect(created.body.template_id).toBe(id);
    expect(created.body.template_version).toBe(1);
    createdReportIds.push(created.body.report_id);

    // Edit the template (new version, still active) — the already-created report must not care.
    const v2Definition = {
      pages: [{ sections: [{ type: 'text', label: 'Remarks:', dataKey: 'remarks', default: 'V2 TEXT — SHOULD NOT APPEAR' }] }],
    };
    await request(app).put(`/api/pdi/admin/templates/${id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Pin Test', definition: v2Definition });
    await request(app).post(`/api/pdi/admin/templates/${id}/publish`).set('Authorization', `Bearer ${adminToken}`);

    const pdf = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
    // The report's own pinned version (1) is still what gets rendered — confirmed
    // by re-fetching the report and checking template_version is unchanged, since
    // the PDF bytes themselves aren't practical to text-search (see the earlier
    // CID-encoding finding from the renderer task's own review).
    const refetched = await request(app)
      .get(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(refetched.body.template_version).toBe(1);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx jest tests/pdi_admin.test.js --forceExit`
Expected: PASS (10/10)

Run: `npx jest tests/pdiReports.test.js --forceExit`
Expected: PASS (14/14) — confirms the `getTemplates` merge didn't break the existing "lists the registered templates" test's exact-match assertion. If it now fails because that test asserts an exact array (`[general, autonxt]`) and your test run leaves an `active` DB template behind, check Step 5's tests clean up via `createdIds`/`afterAll` correctly — don't weaken the existing test's assertion to fix a leftover-data problem.

- [ ] **Step 7: Commit**

```bash
git add controllers/operations/pdi.admin.controller.js routes/operations/pdiAdmin.js controllers/operations/pdi.controller.js server.js
git add -f tests/pdi_admin.test.js
git commit -m "feat: add admin API for PDI template authoring (CRUD, publish, archive, preview)"
```

---

### Task 6: Frontend — admin template list + editor page

**Files:**
- Create: `CRM/src/components/admin/PdiTemplatesAdminPage.jsx`
- Modify: `CRM/src/routeConfig.jsx`
- Modify: `CRM/src/constants.js`
- Modify: `CRM/src/components/dashboards/AdminDashboard.jsx`

This is a large component; build it in the structure below. It has two views (list, editor) toggled by local state on one route — not two separate routes — so switching between them is instant.

Known, deliberate v1 gap: the header section editor below doesn't expose `extraFormatLines` or `logoAsset` — both are rare fields (so far only General's/AutoNXT's hand-coded templates have needed a logo or a 4th format-box line at all), and the hydrated shape already treats them as fully optional (`section.extraFormatLines || []`). An authored template simply can't set them yet; that's an accepted limitation for this phase, not a bug to fix here.

- [ ] **Step 1: Create the page component**

```jsx
// CRM/src/components/admin/PdiTemplatesAdminPage.jsx
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Eye, Upload, Archive } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const SECTION_TYPES = ['header', 'table', 'photo', 'image', 'signature', 'text'];

function emptySection(type) {
  switch (type) {
    case 'header':
      return { type, companyName: '', formatNo: '', revNo: '', effDate: '', extraFormatLines: [], logoAsset: null, infoFields: [] };
    case 'table':
      return { type, title: '', mode: 'repeatable', dataKey: '', columns: [], headerHeight: 20, rowHeight: 14, filterKey: '', fixedRows: [] };
    case 'photo':
      return { type, mode: 'freeform', dataKey: '', slots: [] };
    case 'image':
      return { type, dataKey: '', width: null, height: 100, title: '', placeholder: null };
    case 'signature':
      return { type, roles: [] };
    case 'text':
      return { type, label: '', dataKey: '', default: '' };
    default:
      throw new Error(`Unknown section type: ${type}`);
  }
}

function emptyDefinition() {
  return { pages: [{ sections: [] }] };
}

function moveItem(arr, index, delta) {
  const next = [...arr];
  const target = index + delta;
  if (target < 0 || target >= next.length) return arr;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// ── Small reusable list-editor: add/remove/reorder rows of a fixed shape ──
function ListEditor({ items, onChange, renderRow, newRow, addLabel }) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 border border-gray-200 rounded p-2">
          <div className="flex flex-col">
            <button type="button" onClick={() => onChange(moveItem(items, i, -1))} disabled={i === 0} className="disabled:opacity-30">
              <ChevronUp size={14} />
            </button>
            <button type="button" onClick={() => onChange(moveItem(items, i, 1))} disabled={i === items.length - 1} className="disabled:opacity-30">
              <ChevronDown size={14} />
            </button>
          </div>
          <div className="flex-1">{renderRow(item, (updated) => onChange(items.map((it, idx) => (idx === i ? updated : it))))}</div>
          <button type="button" onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="text-red-500 hover:text-red-700">
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

const FIELD_CLS = 'border border-gray-300 rounded px-2 py-1 text-sm w-full';

function HeaderSectionEditor({ section, onChange }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input className={FIELD_CLS} placeholder="Company name" value={section.companyName} onChange={(e) => onChange({ ...section, companyName: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Format No." value={section.formatNo} onChange={(e) => onChange({ ...section, formatNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Rev No." value={section.revNo} onChange={(e) => onChange({ ...section, revNo: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Eff. Date" value={section.effDate} onChange={(e) => onChange({ ...section, effDate: e.target.value })} />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600">Info fields (top-of-page label/value rows)</label>
        <ListEditor
          items={section.infoFields}
          onChange={(infoFields) => onChange({ ...section, infoFields })}
          addLabel="Add info row"
          newRow={() => ({ leftLabel: '', leftKey: '', leftFormat: 'text', rightLabel: '', rightKey: '', rightFormat: 'text' })}
          renderRow={(row, update) => (
            <div className="grid grid-cols-6 gap-1 text-xs">
              <input className={FIELD_CLS} placeholder="Left label" value={row.leftLabel} onChange={(e) => update({ ...row, leftLabel: e.target.value })} />
              <input className={FIELD_CLS} placeholder="Left data key" value={row.leftKey} onChange={(e) => update({ ...row, leftKey: e.target.value })} />
              <select className={FIELD_CLS} value={row.leftFormat} onChange={(e) => update({ ...row, leftFormat: e.target.value })}>
                <option value="text">text</option><option value="date">date</option>
              </select>
              <input className={FIELD_CLS} placeholder="Right label" value={row.rightLabel} onChange={(e) => update({ ...row, rightLabel: e.target.value })} />
              <input className={FIELD_CLS} placeholder="Right data key" value={row.rightKey} onChange={(e) => update({ ...row, rightKey: e.target.value })} />
              <select className={FIELD_CLS} value={row.rightFormat} onChange={(e) => update({ ...row, rightFormat: e.target.value })}>
                <option value="text">text</option><option value="date">date</option>
              </select>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function CellSourceEditor({ cell, onChange }) {
  const source = cell?.source || 'row';
  return (
    <div className="flex gap-1 items-center">
      <select className={FIELD_CLS} value={source} onChange={(e) => {
        const s = e.target.value;
        if (s === 'row') onChange({ source: 'row' });
        else if (s === 'constant') onChange({ source: 'constant', value: '' });
        else onChange({ source: 'sectionData', subfield: 'measured', default: 'GO' });
      }}>
        <option value="row">row field</option>
        <option value="constant">constant</option>
        <option value="sectionData">per-inspection value</option>
      </select>
      {source === 'constant' && (
        <input className={FIELD_CLS} placeholder="Value" value={cell.value} onChange={(e) => onChange({ ...cell, value: e.target.value })} />
      )}
      {source === 'sectionData' && (
        <>
          <input className={FIELD_CLS} placeholder="Subfield" value={cell.subfield} onChange={(e) => onChange({ ...cell, subfield: e.target.value })} />
          <input className={FIELD_CLS} placeholder="Default" value={cell.default} onChange={(e) => onChange({ ...cell, default: e.target.value })} />
        </>
      )}
    </div>
  );
}

function TableSectionEditor({ section, onChange }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input className={FIELD_CLS} placeholder="Title (optional caption above the table)" value={section.title || ''} onChange={(e) => onChange({ ...section, title: e.target.value })} />
        <input className={FIELD_CLS} placeholder="Data key" value={section.dataKey} onChange={(e) => onChange({ ...section, dataKey: e.target.value })} />
        <select className={FIELD_CLS} value={section.mode} onChange={(e) => onChange({ ...section, mode: e.target.value })}>
          <option value="repeatable">repeatable (one row per item)</option>
          <option value="fixed">fixed (template-defined rows)</option>
        </select>
        {section.mode === 'repeatable' && (
          <input className={FIELD_CLS} placeholder="Filter key (row is skipped if this field is empty)" value={section.filterKey || ''} onChange={(e) => onChange({ ...section, filterKey: e.target.value })} />
        )}
        <input className={FIELD_CLS} type="number" placeholder="Header height" value={section.headerHeight} onChange={(e) => onChange({ ...section, headerHeight: Number(e.target.value) })} />
        <input className={FIELD_CLS} type="number" placeholder="Row height" value={section.rowHeight} onChange={(e) => onChange({ ...section, rowHeight: Number(e.target.value) })} />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600">Columns</label>
        <ListEditor
          items={section.columns}
          onChange={(columns) => onChange({ ...section, columns })}
          addLabel="Add column"
          newRow={() => ({ key: '', label: '', w: null, align: 'left', group: '', cell: { source: 'row' } })}
          renderRow={(col, update) => (
            <div className="grid grid-cols-5 gap-1 text-xs items-center">
              <input className={FIELD_CLS} placeholder="key" value={col.key} onChange={(e) => update({ ...col, key: e.target.value })} />
              <input className={FIELD_CLS} placeholder="label" value={col.label} onChange={(e) => update({ ...col, label: e.target.value })} />
              <input className={FIELD_CLS} type="number" placeholder="width (blank=flex)" value={col.w ?? ''} onChange={(e) => update({ ...col, w: e.target.value ? Number(e.target.value) : null })} />
              <input className={FIELD_CLS} placeholder="group (optional)" value={col.group || ''} onChange={(e) => update({ ...col, group: e.target.value || undefined })} />
              <CellSourceEditor cell={col.cell} onChange={(cell) => update({ ...col, cell })} />
            </div>
          )}
        />
      </div>
      {section.mode === 'fixed' && (
        <div>
          <label className="text-xs font-medium text-gray-600">Fixed rows (one per checklist item — "key" links this row's per-inspection value)</label>
          <ListEditor
            items={section.fixedRows}
            onChange={(fixedRows) => onChange({ ...section, fixedRows })}
            addLabel="Add row"
            newRow={() => ({ key: '' })}
            renderRow={(row, update) => (
              <div className="grid gap-1 text-xs" style={{ gridTemplateColumns: `repeat(${section.columns.length + 1}, 1fr)` }}>
                <input className={FIELD_CLS} placeholder="row key" value={row.key || ''} onChange={(e) => update({ ...row, key: e.target.value })} />
                {section.columns.filter((c) => !c.cell || c.cell.source === 'row').map((c) => (
                  <input key={c.key} className={FIELD_CLS} placeholder={c.label || c.key} value={row[c.key] || ''} onChange={(e) => update({ ...row, [c.key]: e.target.value })} />
                ))}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}

function PhotoSectionEditor({ section, onChange }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <select className={FIELD_CLS} value={section.mode} onChange={(e) => onChange({ ...section, mode: e.target.value })}>
          <option value="freeform">freeform (user adds photos)</option>
          <option value="fixed-slots">fixed slots</option>
        </select>
        <input className={FIELD_CLS} placeholder="Data key" value={section.dataKey} onChange={(e) => onChange({ ...section, dataKey: e.target.value })} />
      </div>
      {section.mode === 'fixed-slots' && (
        <ListEditor
          items={section.slots}
          onChange={(slots) => onChange({ ...section, slots })}
          addLabel="Add slot"
          newRow={() => ({ key: '', label: '' })}
          renderRow={(slot, update) => (
            <div className="grid grid-cols-2 gap-1 text-xs">
              <input className={FIELD_CLS} placeholder="key" value={slot.key} onChange={(e) => update({ ...slot, key: e.target.value })} />
              <input className={FIELD_CLS} placeholder="label" value={slot.label} onChange={(e) => update({ ...slot, label: e.target.value })} />
            </div>
          )}
        />
      )}
    </div>
  );
}

function ImageSectionEditor({ section, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <input className={FIELD_CLS} placeholder="Data key" value={section.dataKey} onChange={(e) => onChange({ ...section, dataKey: e.target.value })} />
      <input className={FIELD_CLS} placeholder="Title (optional)" value={section.title || ''} onChange={(e) => onChange({ ...section, title: e.target.value })} />
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

function SignatureSectionEditor({ section, onChange }) {
  return (
    <ListEditor
      items={section.roles}
      onChange={(roles) => onChange({ ...section, roles })}
      addLabel="Add signer"
      newRow={() => ({ key: '', label: '' })}
      renderRow={(role, update) => (
        <div className="grid grid-cols-2 gap-1 text-xs">
          <input className={FIELD_CLS} placeholder="key" value={role.key} onChange={(e) => update({ ...role, key: e.target.value })} />
          <input className={FIELD_CLS} placeholder="label" value={role.label} onChange={(e) => update({ ...role, label: e.target.value })} />
        </div>
      )}
    />
  );
}

function TextSectionEditor({ section, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <input className={FIELD_CLS} placeholder="Label" value={section.label} onChange={(e) => onChange({ ...section, label: e.target.value })} />
      <input className={FIELD_CLS} placeholder="Data key" value={section.dataKey} onChange={(e) => onChange({ ...section, dataKey: e.target.value })} />
      <input className={FIELD_CLS} placeholder="Default text" value={section.default || ''} onChange={(e) => onChange({ ...section, default: e.target.value })} />
    </div>
  );
}

function SectionEditor({ section, onChange }) {
  const Editor = {
    header: HeaderSectionEditor, table: TableSectionEditor, photo: PhotoSectionEditor,
    image: ImageSectionEditor, signature: SignatureSectionEditor, text: TextSectionEditor,
  }[section.type];
  return (
    <div className="bg-gray-50 rounded p-3">
      <div className="text-xs font-semibold text-gray-500 uppercase mb-2">{section.type} section</div>
      <Editor section={section} onChange={onChange} />
    </div>
  );
}

function PageEditor({ page, onChange }) {
  return (
    <div className="space-y-3">
      <ListEditor
        items={page.sections}
        onChange={(sections) => onChange({ ...page, sections })}
        addLabel="Add section"
        newRow={() => emptySection('header')}
        renderRow={(section, update) => (
          <div className="space-y-2">
            <select className={FIELD_CLS} value={section.type} onChange={(e) => update(emptySection(e.target.value))}>
              {SECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <SectionEditor section={section} onChange={update} />
          </div>
        )}
      />
    </div>
  );
}

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

  const preview = async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates/${template.id}/preview`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ definition }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Preview failed');
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (err) {
      notifyError(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input className={FIELD_CLS + ' text-lg font-semibold'} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="text-xs text-gray-400">id: {template.id}</span>
      </div>
      <div className="space-y-4">
        {definition.pages.map((page, i) => (
          <div key={i} className="border border-gray-300 rounded p-3">
            <div className="text-sm font-semibold mb-2">Page {i + 1}</div>
            <PageEditor page={page} onChange={(p) => {
              const pages = [...definition.pages];
              pages[i] = p;
              setDefinition({ ...definition, pages });
            }} />
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
        <button type="button" onClick={preview} className="flex items-center gap-1 px-3 py-2 border rounded text-sm"><Eye size={16} /> Preview PDF</button>
        <button type="button" disabled={saving} onClick={() => save(null)} className="px-3 py-2 border rounded text-sm">Save</button>
        <button type="button" disabled={saving} onClick={() => save('publish')} className="flex items-center gap-1 px-3 py-2 bg-amber-500 text-white rounded text-sm"><Upload size={16} /> Save &amp; Publish</button>
        <button type="button" disabled={saving} onClick={() => save('archive')} className="flex items-center gap-1 px-3 py-2 border rounded text-sm text-gray-600"><Archive size={16} /> Archive</button>
        <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-500">Close</button>
      </div>
    </div>
  );
}

export default function PdiTemplatesAdminPage() {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null); // full template row being edited, or null
  const [creatingId, setCreatingId] = useState('');
  const [creatingName, setCreatingName] = useState('');
  const { notifyError, notifySuccess } = useNotify();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load templates');
      setList(await res.json());
    } catch (err) {
      notifyError(err.message);
    }
  }, [notifyError]);

  useEffect(() => { refresh(); }, [refresh]);

  const openEditor = async (id) => {
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates/${id}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load template');
      setEditing(await res.json());
    } catch (err) {
      notifyError(err.message);
    }
  };

  const createTemplate = async () => {
    if (!creatingId.trim() || !creatingName.trim()) return;
    try {
      const res = await fetch(`${BASE_URL}/api/pdi/admin/templates`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ id: creatingId.trim(), name: creatingName.trim(), definition: emptyDefinition() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Create failed');
      notifySuccess('Template created.');
      setCreatingId(''); setCreatingName('');
      await refresh();
      setEditing(body);
    } catch (err) {
      notifyError(err.message);
    }
  };

  if (editing) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-4xl mx-auto bg-white rounded-xl shadow p-6">
          <TemplateEditor
            template={editing}
            onClose={() => { setEditing(null); refresh(); }}
            onSaved={() => openEditor(editing.id)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">PDI Templates</h1>

        <div className="bg-white rounded-xl shadow p-4 mb-6 flex gap-2 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">New template id (slug)</label>
            <input className={FIELD_CLS} value={creatingId} onChange={(e) => setCreatingId(e.target.value)} placeholder="e.g. acme-motor-pdi" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
            <input className={FIELD_CLS} value={creatingName} onChange={(e) => setCreatingName(e.target.value)} placeholder="e.g. Acme Motor PDI" />
          </div>
          <button type="button" onClick={createTemplate} className="flex items-center gap-1 px-4 py-2 bg-amber-500 text-white rounded text-sm font-medium">
            <Plus size={16} /> New Template
          </button>
        </div>

        <div className="bg-white rounded-xl shadow divide-y">
          {!list && <div className="p-4 text-gray-400">Loading...</div>}
          {list && list.length === 0 && <div className="p-4 text-gray-400">No authored templates yet.</div>}
          {list && list.map((t) => (
            <div key={t.id} className="p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-gray-400">{t.id} · v{t.version} · {t.status}</div>
              </div>
              <button type="button" onClick={() => openEditor(t.id)} className="text-sm text-amber-700 font-medium">Edit</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Route + navigation**

In `CRM/src/routeConfig.jsx`, add the import near the other `./components/admin/...` imports:
```js
import PdiTemplatesAdminPage from "./components/admin/PdiTemplatesAdminPage";
```
Add a new route (near the other `/pdi*` entries):
```js
{
  path: "/pdi-templates",
  allowedRoles: ["admin"],
  component: PdiTemplatesAdminPage,
},
```

In `CRM/src/constants.js`, add `/pdi-templates` to the `admin` role's array in `allowedPathsByRole` (the same allowlist that already has a comment reminding you to add new PDI routes here per role — this route is admin-only, so it only needs to go in that one array, not production's).

In `CRM/src/components/dashboards/AdminDashboard.jsx`, find the existing PDI-related `DashboardCard` entries (search for `PDI Generator`) and add a sibling card:
```jsx
<DashboardCard to="/pdi-templates" icon={<FileEdit />} title="PDI Templates" desc="Author new PDI report formats" />
```
Check the file's existing icon imports from `lucide-react` at the top and add `FileEdit` (or whatever icon name isn't already imported and reads reasonably — check the file's actual import line first, don't guess blindly).

- [ ] **Step 3: Verify**

```bash
npx eslint src/components/admin/PdiTemplatesAdminPage.jsx src/routeConfig.jsx src/constants.js src/components/dashboards/AdminDashboard.jsx
npm run build
```
Both must be clean (the pre-existing >500kB chunk-size build warning is expected and fine).

- [ ] **Step 4: Manual verification**

If you have a live backend + database available (start it per this session's established pattern: `FRONTEND_URL=http://localhost:5173 npm run dev` in CRM_BACKEND, `npm run dev` in CRM), walk through: log in as an admin, open PDI Templates from the dashboard, create a new template, add a page with a `text` section and a `signature` section, click Preview PDF (confirm a PDF opens), Save & Publish, confirm it now appears via `GET /api/pdi/templates`. If no live environment is available in your session, say so explicitly and rely on lint/build plus careful code reading — do not fabricate a "verified live" claim.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PdiTemplatesAdminPage.jsx src/routeConfig.jsx src/constants.js src/components/dashboards/AdminDashboard.jsx
git commit -m "feat: add PDI template authoring admin page"
```

---

### Task 7: Full-stack live verification

Not a subagent task — the controller (you, continuing this session) does this personally, the same way Phase 1's General re-expression and both frontend routing tasks got a live gstack walkthrough before shipping. This is new, previously-unexercised code (a whole new DB table, a new adapter, new admin endpoints, a new admin page) — it needs a real end-to-end pass, not just unit tests, before pushing.

Walk through: start both dev servers, log in as an admin, create a template via the UI with at least one `header`, one `repeatable table`, one `fixed table` (with a `sectionData`-sourced column), a `text`, and a `signature` section, preview it, publish it, then — using the existing template picker at `/pdi-generator` — confirm the new template now appears as a third option, create a report against it (this will fail gracefully with a clear error, since no form component exists for a DB-authored template yet — confirm the *backend* creation call itself succeeds with the right `template_id`/`template_version`, even though there's no UI path to fill it out and finalize; that's expected and matches this phase's scope, which explicitly excludes auto-generating a form). Confirm via direct DB query that the created report's `template_version` matches the published version. Clean up any test data created (templates, reports, users) the same way earlier tasks in this session have.
