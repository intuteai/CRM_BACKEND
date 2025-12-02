// utils/googleDrive.js
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// Config
const KEYFILE_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || 'secrets/drive-sa.json';
const KEYFILE = path.join(__dirname, '..', KEYFILE_PATH);
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

if (!fs.existsSync(KEYFILE)) {
  console.warn('Google service account keyfile not found at:', KEYFILE);
  console.warn('Uploads will fail until the service account key is placed correctly.');
}

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE,
  scopes: ['https://www.googleapis.com/auth/drive']
});

/**
 * Uploads a buffer to Google Drive (in your configured folder)
 * Makes the file publicly viewable ("Anyone with the link")
 * Returns a direct <img>-friendly URL that works forever
 */
async function uploadBufferToDrive(buffer, mimeType, filename) {
  if (!FOLDER_ID) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set in .env');
  }

  const client = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: client });

  const stream = new PassThrough();
  stream.end(buffer);

  // Step 1: Upload the file
  const uploadResponse = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [FOLDER_ID],
    },
    media: {
      mimeType,
      body: stream,
    },
    supportsAllDrives: true,
    fields: 'id', // We only need the ID for now
  });

  const fileId = uploadResponse.data.id;

  // Step 2: Make it publicly viewable (critical for service accounts!)
  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: {
      role: 'reader',
      type: 'anyone', // Anyone with the link can view
    },
  });

  // Step 3: Return the only direct link that reliably works in <img> tags in 2025+
  // FIXED: Swapped parameter order to ?export=view&id= (uc?export=view&id=FILE_ID)
  const directUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

  return {
    id: fileId,
    directUrl,                    // Use this in your DB and frontend
    webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    webContentLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
  };
}

module.exports = {
  uploadBufferToDrive,
};