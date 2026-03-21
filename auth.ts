/**
 * auth.ts — Local Google OAuth flow for Rose
 *
 * Run with: npm run auth
 *
 * This script:
 * 1. Reads your GOOGLE_CREDENTIALS_JSON from .env (or env)
 * 2. Prints an auth URL for you to visit in a browser
 * 3. Waits for you to paste the auth code back
 * 4. Exchanges the code for tokens
 * 5. Prints the resulting GOOGLE_TOKEN_JSON to paste into Railway
 */

import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main(): Promise<void> {
  console.log('\n🌹 Rose — Google Calendar Auth Setup\n');

  // Load credentials
  const credentialsJson = process.env['GOOGLE_CREDENTIALS_JSON'];
  if (!credentialsJson) {
    // Try to load from credentials.json file as fallback
    if (fs.existsSync('./credentials.json')) {
      process.env['GOOGLE_CREDENTIALS_JSON'] = fs.readFileSync('./credentials.json', 'utf8');
      console.log('Loaded credentials from credentials.json');
    } else {
      console.error('❌ GOOGLE_CREDENTIALS_JSON environment variable is not set.');
      console.error(
        'Either set it in your .env file or place your credentials.json in this directory.'
      );
      console.error('\nTo get credentials:');
      console.error('1. Go to https://console.cloud.google.com/');
      console.error('2. Create a project → Enable Google Calendar API');
      console.error('3. Create OAuth 2.0 credentials (Desktop app)');
      console.error('4. Download the JSON and paste it as GOOGLE_CREDENTIALS_JSON in your .env');
      process.exit(1);
    }
  }

  let credentials: {
    installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
    web?: { client_id: string; client_secret: string; redirect_uris: string[] };
  };

  try {
    credentials = JSON.parse(process.env['GOOGLE_CREDENTIALS_JSON'] || '{}');
  } catch {
    console.error('❌ GOOGLE_CREDENTIALS_JSON is not valid JSON.');
    process.exit(1);
  }

  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web || ({} as { client_id: string; client_secret: string; redirect_uris: string[] });

  if (!client_id || !client_secret) {
    console.error('❌ Could not find client_id or client_secret in credentials.');
    process.exit(1);
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to get refresh_token
  });

  console.log('Step 1: Visit this URL in your browser to authorise Rose:\n');
  console.log(authUrl);
  console.log('\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question('Step 2: Paste the authorisation code from the browser here: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    const tokenJson = JSON.stringify(tokens);

    console.log('\n✅ Success! Here is your GOOGLE_TOKEN_JSON:\n');
    console.log('─'.repeat(80));
    console.log(tokenJson);
    console.log('─'.repeat(80));
    console.log('\nStep 3: Copy the JSON string above and add it to Railway as:');
    console.log('  Variable name:  GOOGLE_TOKEN_JSON');
    console.log('  Variable value: (the JSON string above)');
    console.log('\nDone! Rose is ready to connect to your Google Calendar 🌹\n');

    // Also save locally for convenience
    fs.writeFileSync('./token.json', tokenJson);
    console.log('(Also saved locally to token.json for reference — do not commit this file!)');
  } catch (err) {
    console.error('❌ Error retrieving access token:', err);
    process.exit(1);
  }
}

main();
