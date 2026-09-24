'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../../utils/logger');

// A finished (Completed) PDI report is locked against edits, so the PDF built
// when it was finalized is the PDF it will always have -- there is nothing to
// gain by rendering it again on every "View PDF" / recovery request. This keeps
// the last MAX_FILES of them on the server's disk and serves them straight back.
//
// It is only a cache: the disk is the container's own, so a redeploy empties it,
// and a miss just falls back to rendering from the stored report, exactly as
// before. Every operation here is best-effort and never throws -- a full or
// read-only disk must not break finalizing or downloading.
const MAX_FILES = 100;

// Resolved on each call (not at load) so a test can point it at a temp folder.
const cacheDir = () => process.env.PDI_PDF_CACHE_DIR || path.join(os.tmpdir(), 'pdi-pdf-cache');
const fileFor = (reportId) => path.join(cacheDir(), `report-${Number(reportId)}.pdf`);

async function read(reportId) {
  try {
    const buf = await fs.promises.readFile(fileFor(reportId));
    if (buf.length > 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return buf;
    await remove(reportId); // a truncated/garbled file is worse than a miss
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache read failed for report ${reportId}: ${e.message}`);
    return null;
  }
}

// Written to a temp name then renamed, so a reader never sees a half-written file.
async function write(reportId, buffer) {
  try {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
    const target = fileFor(reportId);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(temp, buffer);
    await fs.promises.rename(temp, target);
    await evictOldest();
    return true;
  } catch (e) {
    logger.warn(`PDI PDF cache write failed for report ${reportId}: ${e.message}`);
    return false;
  }
}

async function remove(reportId) {
  try {
    await fs.promises.unlink(fileFor(reportId));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`PDI PDF cache remove failed for report ${reportId}: ${e.message}`);
  }
}

async function evictOldest() {
  const dir = cacheDir();
  const names = (await fs.promises.readdir(dir)).filter((n) => /^report-\d+\.pdf$/.test(n));
  if (names.length <= MAX_FILES) return;
  const withTimes = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })));
  withTimes.sort((a, b) => a.t - b.t);
  await Promise.all(withTimes.slice(0, names.length - MAX_FILES).map((f) => fs.promises.unlink(path.join(dir, f.n)).catch(() => {})));
}

module.exports = { read, write, remove, MAX_FILES };
