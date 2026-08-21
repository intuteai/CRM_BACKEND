const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const KEYFILE_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || 'secrets/drive-sa.json';
const KEYFILE = path.join(__dirname, '..', KEYFILE_PATH);
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

if (!fs.existsSync(KEYFILE)) {
  console.warn('Google service account keyfile not found at:', KEYFILE);
  console.warn('Uploads will fail until the service account key is placed correctly.');
}

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function uploadBufferToDrive(buffer, mimeType, filename) {
  if (!FOLDER_ID) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set in .env');
  }

  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  const stream = new PassThrough();
  stream.end(buffer);

  const uploadResponse = await drive.files.create({
    requestBody: { name: filename, parents: [FOLDER_ID] },
    media: { mimeType, body: stream },
    supportsAllDrives: true,
    fields: 'id',
  });

  const fileId = uploadResponse.data.id;

  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    id: fileId,
    directUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
    webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    webContentLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
  };
}

// Same as uploadBufferToDrive but does NOT grant "anyone with the link" reader
// access — the file stays private to the service account. Use this for
// sensitive documents (e.g. invoices) that must only be viewable through an
// authenticated backend route, via streamFileToDrive below.
async function uploadBufferToDrivePrivate(buffer, mimeType, filename) {
  if (!FOLDER_ID) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set in .env');
  }

  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  const stream = new PassThrough();
  stream.end(buffer);

  const uploadResponse = await drive.files.create({
    requestBody: { name: filename, parents: [FOLDER_ID] },
    media: { mimeType, body: stream },
    supportsAllDrives: true,
    fields: 'id',
  });

  return { id: uploadResponse.data.id };
}

async function streamFileToDrive(fileId, res) {
  const client = await auth.getClient();
  const drive   = google.drive({ version: 'v3', auth: client });

  const meta = await drive.files.get({
    fileId,
    fields: 'mimeType,name',
    supportsAllDrives: true,
  });
  const mimeType = meta.data.mimeType || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const dl = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  dl.data.pipe(res);
}

// Trashes rather than permanently deletes. The service account's role on the
// target Shared Drive grants canTrash but not canDelete — files.delete()
// reliably 404s ("File not found") even on a file that indisputably exists,
// because Drive reports permission-denied as not-found here. Trashed files
// are auto-purged by Drive after 30 days, which is an acceptable (and safer)
// substitute for a hard delete.
async function deleteDriveFile(fileId) {
  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });
  await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { trashed: true } });
}

module.exports = { uploadBufferToDrive, uploadBufferToDrivePrivate, streamFileToDrive, deleteDriveFile };
