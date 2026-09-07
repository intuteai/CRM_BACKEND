'use strict';

// Duplicates renderer.js's own private TEXT_H/SIG_H constants (36/40) —
// renderer.js doesn't export them, so there's no shared source of truth to
// import from. If those change there, this must be updated by hand to match.
const TEXT_H = 40;
const SIG_H = 36;
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
  if (!Array.isArray(columns)) {
    throw new Error('Table section is missing its columns array');
  }
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
  if (!Array.isArray(section.infoFields)) {
    throw new Error('Header section is missing its infoFields array');
  }
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
    // NOTE: every section.type case `hydrateSection` (above) knows about
    // must have a matching branch here too — this loop has no `default`/
    // throw, so a new section type forgotten here just silently produces
    // no sample data for it (a missing preview field), not an error. Keep
    // the two in sync by hand when adding a new section type.
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
