/**
 * Google OAuth Setup Script
 *
 * Run this script once to authorize the app with Google Drive and Gmail.
 * It will open a browser for you to login and save the token.
 *
 * Usage: node setup-google-auth.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

// Scopes for both Google Drive and Gmail
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email'
];

const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

async function main() {
  console.log(`
  ╔════════════════════════════════════════════════════════════╗
  ║           Google OAuth Setup                               ║
  ║           (Drive + Gmail)                                  ║
  ╚════════════════════════════════════════════════════════════╝
  `);

  // Check for credentials file
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.log(`
  ERROR: credentials.json not found!

  To set up Google integration:

  1. Go to https://console.cloud.google.com/
  2. Create a new project (or select existing)

  3. Enable the required APIs:
     - Go to "APIs & Services" > "Library"
     - Search and enable "Google Drive API"
     - Search and enable "Gmail API"

  4. Configure OAuth consent screen:
     - Go to "APIs & Services" > "OAuth consent screen"
     - Select "External" (or "Internal" if using Workspace)
     - Fill in app name and your email
     - Add scopes: drive.file, gmail.send
     - Add your email as a test user

  5. Create OAuth credentials:
     - Go to "APIs & Services" > "Credentials"
     - Click "Create Credentials" > "OAuth client ID"
     - Application type: "Desktop app"
     - Download the JSON file

  6. Rename the downloaded file to "credentials.json"
  7. Place it in the root of this project
  8. Run this script again

  `);
    process.exit(1);
  }

  // Load credentials
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const clientConfig = credentials.installed || credentials.web;

  if (!clientConfig) {
    console.log('Invalid credentials.json format. Must be OAuth credentials (not service account).');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris ? clientConfig.redirect_uris[0] : 'http://localhost'
  );

  // Check if we already have a token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);

    // Test the token
    try {
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      await drive.files.list({ pageSize: 1 });

      console.log('  ✓ Existing token is valid!');
      console.log('  ✓ Google Drive integration is ready.');

      // Check Gmail
      try {
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        console.log(`  ✓ Gmail integration ready for: ${userInfo.data.email}`);

        // Save email to token
        token.email = userInfo.data.email;
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
      } catch (e) {
        console.log('  ⚠ Gmail scope may need to be re-authorized');
      }

      console.log('\n  You can now run: npm start\n');
      process.exit(0);
    } catch (e) {
      console.log('  ⚠ Existing token is expired. Getting new token...\n');
    }
  }

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('  This will authorize the app for:');
  console.log('    - Google Drive (create folders and upload files)');
  console.log('    - Gmail (send emails with attachments)\n');

  console.log('  1. Open this URL in your browser:\n');
  console.log(`     ${authUrl}\n`);
  console.log('  2. Sign in with your Google account');
  console.log('  3. Click "Allow" to grant access');
  console.log('  4. Copy the authorization code\n');

  // Get code from user
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('  Enter the authorization code: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await oauth2Client.getToken(code.trim());
      oauth2Client.setCredentials(tokens);

      // Get user email
      try {
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        tokens.email = userInfo.data.email;
        console.log(`\n  ✓ Authorized as: ${userInfo.data.email}`);
      } catch (e) {
        console.log('\n  ✓ Authorization successful');
      }

      // Save the token
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

      console.log(`  ✓ Token saved to ${TOKEN_PATH}`);
      console.log('  ✓ Google Drive + Gmail integration is ready!\n');
      console.log('  You can now run: npm start\n');
    } catch (error) {
      console.log(`
  ERROR: Failed to get token: ${error.message}

  Make sure you copied the full authorization code.
  If the code has a '#' in it, only copy the part before it.
      `);
      process.exit(1);
    }
  });
}

main();
