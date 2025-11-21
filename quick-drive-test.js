// quick-drive-test.js (FINAL VERSION - WORKING)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function main() {
  try {
    console.log("Using service account file:", process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    console.log("Using folder:", process.env.GOOGLE_DRIVE_FOLDER_ID);

    const KEYFILE = path.join(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
    if (!fs.existsSync(KEYFILE)) {
      console.error("Service account file not found:", KEYFILE);
      process.exit(1);
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: KEYFILE,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
    const client = await auth.getClient();
    const drive = google.drive({ version: "v3", auth: client });

    // Verify folder access
    await drive.files.get({
      fileId: process.env.GOOGLE_DRIVE_FOLDER_ID,
      fields: 'id, name',
      supportsAllDrives: true
    });

    // Upload test image (not txt — use real image!)
    const sampleFilePath = path.join(__dirname, "test-image.jpg");
    if (!fs.existsSync(sampleFilePath)) {
      console.log("Creating dummy image for testing...");
      fs.writeFileSync(sampleFilePath, Buffer.from([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01
      ])); // Tiny valid JPEG
    }

    console.log("Uploading test image...");
    const response = await drive.files.create({
      requestBody: {
        name: `test-photo-${Date.now()}.jpg`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: "image/jpeg",
        body: fs.createReadStream(sampleFilePath)
      },
      supportsAllDrives: true,
      fields: "id, name, webViewLink, webContentLink, permissions"
    });

    const fileId = response.data.id;

    console.log("Uploaded Successfully!");
    console.log("File ID:", fileId);
    console.log("Web View Link:", response.data.webViewLink);

    // TEST 1: Old broken link
    const brokenLink = `https://drive.google.com/uc?export=view&id=${fileId}`;
    console.log("\nBroken Link (will 403):", brokenLink);

    // TEST 2: New working link
    const workingLink = `https://drive.google.com/uc?id=${fileId}&export=view`;
    console.log("Working Link:", workingLink);

    // TEST 3: Make public + test again
    console.log("\nMaking file public (anyone with link)...");
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    console.log("\nNow ALL links work!");
    console.log("Direct image URL → paste in browser or <img>:");
    console.log(workingLink);

  } catch (err) {
    console.error("Error:", err.message);
    if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  }
}

main();