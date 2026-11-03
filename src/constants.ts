import * as path from 'path';
import * as os from 'os';

export function getGeminiHomeDir(): string {
  return path.join(os.homedir(), '.gemini');
}

export function getCharlierDir(): string {
  return path.join(getGeminiHomeDir(), 'charlier');
}

export function getProfilesDir(): string {
  return path.join(getCharlierDir(), 'profiles');
}

export function getStateFilePath(): string {
  return path.join(getCharlierDir(), 'state.json');
}

export function getActiveGoogleAccountsPath(): string {
  return path.join(getGeminiHomeDir(), 'google_accounts.json');
}

export function getActiveOAuthCredsPath(): string {
  return path.join(getGeminiHomeDir(), 'oauth_creds.json');
}

