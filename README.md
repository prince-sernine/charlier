# Charlier

**Instant, zero-dependency account switcher and profile vault for Google Antigravity.**

Named after the legendary sleight-of-hand cut, **Charlier** transposes active Google Antigravity credentials on disk in under two milliseconds. No SQLite WebAssembly engines, no background telemetry loops, and no sluggish extension host lag.

---

## Why Charlier Exists

Existing community multi-account extensions bundle massive WebAssembly SQLite engines and run polling loops against operating system keyrings, causing noticeable input latency and window freezes.

Google Antigravity natively resolves authentication through two clean JSON stores:
* `~/.gemini/google_accounts.json`
* `~/.gemini/oauth_creds.json`

Charlier manages a clean local profile vault in `~/.gemini/charlier/profiles/`, performing atomic file transpositions when you switch accounts. The underlying Antigravity language server (`agy`) picks up the swapped session immediately without requiring you to re-authenticate through a browser.

---

## Features

* **Sub-2ms Switching:** Pure native Node.js filesystem operations. Zero runtime dependencies.
* **Identity Auto-Discovery:** Automatically extracts the active Google account email from Antigravity stores and tracks token expiry timestamps.
* **Status Bar Integration:** Displays active profile name and email directly in the VS Code status bar.
* **One-Click QuickPick Menu:** Click the status bar pill to switch profiles, snapshot new sessions, or clear tokens to onboard additional accounts.
* **Passive Synchronization:** Event-driven filesystem observer updates UI state when credentials change via external CLI or browser OAuth without polling intervals.
* **Safe Staged Writes:** Uses temporary staged writes and atomic file moves to prevent file corruption during switches.

---

## Quick Start

### 1. Save Your Current Account
1. Open Visual Studio Code with your active Antigravity account signed in.
2. Click the **`$(arrow-swap) Charlier`** status bar pill on the bottom right (or press `Ctrl+Shift+P` and run `Charlier: Save Current Profile`).
3. Enter a label (e.g. `Pro`, `Work`, or `Secondary`).

### 2. Add Another Account
1. Click the status bar pill and select **`Add New Account...`**.
2. Charlier safeguards your current session and clears the live token slot.
3. Reload the window, open the Antigravity chat panel, and complete sign-in with your second Google account.
4. Click the status bar pill and select **`Save Current Session as Profile...`** to label your new account.

### 3. Switch on the Fly
Whenever token quotas dry up:
* Click the Charlier status bar item and pick any saved account from the list.
* Charlier instantly transposes the credentials. Select **Reload Window** if prompted to reconnect the daemon.

---

## Commands

| Command | Identifier | Description |
|---|---|---|
| **Charlier: Switch Profile** | `charlier.switchProfile` | Opens the profile picker and management menu. |
| **Charlier: Save Current Profile** | `charlier.saveProfile` | Snapshots the live Antigravity login into a named profile. |
| **Charlier: Add New Account** | `charlier.addAccount` | Preserves active credentials and prepares for a clean sign-in. |
| **Charlier: Delete Profile** | `charlier.deleteProfile` | Permanently deletes a stored profile from disk. |
| **Charlier: Open Profiles Directory** | `charlier.openVault` | Reveals `~/.gemini/charlier/profiles/` in system explorer. |
| **Charlier: Reload Window** | `charlier.reloadWindow` | Reloads the editor to refresh in-memory daemon leases. |

---

## Architecture & Storage

All profiles are maintained strictly on your local machine:

```
~/.gemini/
├── google_accounts.json       <-- Active identity
├── oauth_creds.json           <-- Active OAuth token
└── charlier/
    ├── state.json             <-- Active profile pointer
    └── profiles/
        ├── personal/
        │   ├── metadata.json
        │   ├── google_accounts.json
        │   └── oauth_creds.json
        └── work/
            ├── metadata.json
            ├── google_accounts.json
            └── oauth_creds.json
```

---

## License

MIT © Sernine

