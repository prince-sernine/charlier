<img src="./media/icon.png" alt="Charlier card-cut icon" width="88" height="88">

# Charlier

**Fast multi-account switcher, local credential vault, and live quota dashboard for Google Antigravity.**

![Windows](https://img.shields.io/badge/Windows-Verified-2ea44f?style=flat-square&labelColor=18181b&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0wIDBoMTEuMzc3djExLjM3Mkgwem0xMi42MjMgMEgyNHYxMS4zNzJIMTIuNjIzek0wIDEyLjYyM2gxMS4zNzdWMjRIMHptMTIuNjIzIDBIMjRWMjRIMTIuNjIzeiIvPjwvc3ZnPg==)
![macOS](https://img.shields.io/badge/macOS-Supported-2ea44f?style=flat-square&labelColor=18181b&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-Supported-2ea44f?style=flat-square&labelColor=18181b&logo=linux&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-2ea44f?style=flat-square&labelColor=18181b)
![License](https://img.shields.io/badge/License-Source_Available-2ea44f?style=flat-square&labelColor=18181b)

---

## Why This Exists

Most multi-account tools for Antigravity either choke the extension host or drop the ball entirely: bloated WebAssembly SQLite runtimes just to parse two JSON keys, background polling loops that stutter the editor, or kicking you out to a browser OAuth screen on every switch.

When you rotate across Free, Pro, and Ultra accounts and hit a 5-hour or weekly quota wall mid-session, you shouldn't have to sign out, open a browser, wait on OAuth callbacks, and re-authenticate just to keep working.

With **Charlier**, you sign into each account once, lock it into your local vault, and swap between them in milliseconds without re-logging in.

Named after the **Charlier pass**: the classic one-handed card cut that shifts the bottom half of the deck to the top in a single clean motion. Pull your next account to the top of the stack in one click and keep moving. Built under **Sernine**.

---

## What It Does

* **Hot-Swap Without Re-Logging In**: Swaps `~/.gemini/google_accounts.json`, `~/.gemini/oauth_creds.json`, and your OS keyring token in one non-blocking pass, then soft-restarts the extension host (`agy`) so your new session goes live in ~150ms without closing your open tabs, terminals, or editor windows.
* **1-Click Switching Right from Hover**: Hover over the status bar pill to view your accounts and click any inactive profile name directly in the hover table to switch immediately. Smart windowing keeps the hover table compact (showing your active session + top recent rotation targets, with a `+ N more in vault` overflow link if you run a large roster).
* **Live Quota Gauges**: Pixel-aligned linen-weave capacity meters (`▓▓▓▓░`) show remaining capacity and exact reset timers across every model pool:
  * **Gemini** *(Flash, Pro)*: 5-hour fast pool and 7-day rolling reserve.
  * **Claude & GPT** *(Opus, Sonnet, GPT-OSS)*: Weekly reserve and reset window.
  * **Gemini 4 Argon**: Dedicated Pro allowance and Ultra pool tracking.
* **Background Refresh for Inactive Accounts**: Mints fresh OAuth access tokens and pulls live quota numbers for your dormant vault accounts directly over HTTPS in the background. You can check which backup account is recharged (`live` or `Xm ago`) without switching into it or interrupting a running agent task.
* **Accurate Plan Badges**: Reads Google's upstream billing tier (`free-tier`, `g1-pro-tier`, `g1-ultra-tier`) directly instead of trusting default consumer flags, with strict cross-profile email isolation so quota data never bleeds across switches.
* **Unsaved Session Guard & Focus Auto-Detect**: When you finish signing into a new Google account in your browser and focus VS Code, Charlier detects the new session automatically, flags it in the status bar (`· Unsaved`), and pins a 1-click save card at the top of the menu. Clicking **Add new account** also backs up your current session automatically before clearing the login slot.
* **Inline QuickPick Controls**: Every profile row in the QuickPick menu includes inline action buttons to inspect its full 5-hour / 7-day quota breakdown or rename it on the spot.

---

## Under the Hood (Clean OS Keyrings, Zero EDR False Positives)

Extensions that touch system credential stores usually bundle native C++ `node-gyp` binaries or drop unsigned `.exe` helpers into your extension folder. On Windows, that lights up Defender and corporate EDR alerts immediately.

Charlier ships **zero runtime dependencies** and **zero unsigned binaries**:

* **OS-Signed Keyring Execution**: Invokes system-signed utilities asynchronously (`execFile`) against the exact credential slots `agy` reads, Base64-encoding Windows secrets in Node before passing them to PowerShell so complex OAuth JSON payloads never hit shell-quoting bugs.
* **Hand-Rolled gRPC-Web & PID Liveness Probing**: Queries your active local `agy` daemon using zero-dependency binary gRPC-Web framing after verifying process PID liveness (`process.kill(pid, 0)`), filtering out stale crash files so hover checks never hang on dead ports.
* **Staged Atomic Swaps & Self-Healing `0.05ms` Cache**: Writes credential files via staged `.tmp` renames with lock fallback (zero chance of 0-byte corrupted token files) and self-heals local session metadata on disk so routine status checks resolve in `~0.05ms` without spawning background processes.

| Platform | Keyring Store | Native Interface |
| :--- | :--- | :--- |
| ![Windows](https://img.shields.io/badge/Windows-18181b?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0wIDBoMTEuMzc3djExLjM3Mkgwem0xMi42MjMgMEgyNHYxMS4zNzJIMTIuNjIzek0wIDEyLjYyM2gxMS4zNzdWMjRIMHptMTIuNjIzIDBIMjRWMjRIMTIuNjIzeiIvPjwvc3ZnPg==) | Windows Credential Manager (`LegacyGeneric:target=gemini:antigravity`) | In-memory `advapi32.dll` (`CredReadW` / `CredWriteW`) & `cmdkey.exe` via signed Windows PowerShell |
| ![macOS](https://img.shields.io/badge/macOS-18181b?style=flat-square&logo=apple&logoColor=white) | macOS Login Keychain (`service: gemini`, `account: antigravity`) | System `/usr/bin/security` (`find-generic-password` / `add-generic-password`) |
| ![Linux](https://img.shields.io/badge/Linux-18181b?style=flat-square&logo=linux&logoColor=white) | FreeDesktop Secret Service (`org.freedesktop.secrets`) | `secret-tool` (`libsecret`) matching `zalando/go-keyring` dual `username` / `account` attributes |

---

## Quick Start

### 1. Save Your Current Account
1. Open VS Code with your Antigravity account signed in.
2. Click **`Charlier`** in the bottom-right status bar (or run `Charlier: Save Current Profile` from the Command Palette).
3. Give it a name (`Main Pro`, `Alt Pro`, `OG Free`).

### 2. Add Another Account
1. Click the Charlier status bar item and select **`Add new account`**.
2. Charlier backs up your current session's latest tokens into your vault and clears the active login slot.
3. Sign in with your next Google account in the Antigravity sidebar.
4. Click the **`Save active account`** card pinned at the top of the Charlier menu to lock it into your vault.

### 3. Switch Any Time
* **From the Hover Panel**: Hover over the status bar pill to check remaining quota across all your saved accounts, then click any profile name in the table to switch immediately.
* **From the QuickPick Menu**: Click the status bar pill and pick an inactive profile. Charlier swaps the credentials and soft-restarts the extension host automatically.

---

## Commands & Settings

| Command | ID | Description |
| :--- | :--- | :--- |
| **Charlier: Switch Profile** | `charlier.switchProfile` | Opens the profile switcher and vault menu. |
| **Charlier: View Quota & Model Limits** | `charlier.viewQuota` | Opens the 5-hour and 7-day quota breakdown for any profile. |
| **Charlier: Refresh Limits** | `charlier.refreshQuota` | Refreshes live limits for both the active session and dormant vault profiles. |
| **Charlier: Save Current Profile** | `charlier.saveProfile` | Saves the active Antigravity session into the vault. |
| **Charlier: Add New Account** | `charlier.addAccount` | Backs up the active session and prepares Antigravity for a new Google sign-in. |
| **Charlier: Rename Profile** | `charlier.renameProfile` | Renames a saved profile in the vault. |
| **Charlier: Delete Profile** | `charlier.deleteProfile` | Removes a saved profile from `~/.gemini/charlier/profiles/`. |
| **Charlier: Open Profiles Directory** | `charlier.openVault` | Opens `~/.gemini/charlier/profiles/` in your system file manager. |
| **Charlier: Restart Extension Host (Soft Reload)** | `charlier.restartExtensionHost` | Soft-reloads extensions and the language server without closing tabs. |
| **Charlier: Reload Window** | `charlier.reloadWindow` | Reloads the full VS Code window and language server. |

### Configuration

* `charlier.autoRestartExtensionHost` *(boolean, default: `true`)*: Automatically soft-restart the VS Code extension host when switching profiles so Antigravity connects to the new account immediately without a full window reload.

---

## Vault Layout

All credentials stay local on your machine inside `~/.gemini/`:

```text
~/.gemini/
├── google_accounts.json                 # Active identity pointer
├── oauth_creds.json                     # Active OAuth session
└── charlier/
    ├── state.json                       # Active profile tracker
    └── profiles/
        ├── main-pro/
        │   ├── metadata.json            # Profile label, email, and cached quota snapshot
        │   ├── keyring_credential.json  # Raw OS keyring payload backup
        │   ├── google_accounts.json     # Account identity store
        │   └── oauth_creds.json         # OAuth token store
        └── og-free/
            ├── metadata.json
            ├── keyring_credential.json
            ├── google_accounts.json
            └── oauth_creds.json
```

---

## Building from Source & Contributing

Contributions, bug reports, and edge-case fixes are welcome. Keep PRs focused, dependency-free, and fast.

```bash
git clone https://github.com/prince-sernine/charlier.git
cd charlier
npm install
npm run build
npx vsce package --no-dependencies
```

---

## License & Ownership

Copyright (c) 2026 **Sernine** ([@prince-sernine](https://github.com/prince-sernine)).

The source code is open so you can read every line that touches your credentials, build it locally for your own use, or send PRs. What you can't do is rip the code or logic, slap a new name on it, and re-upload a clone to the VS Code Marketplace, Open VSX, or another public repo. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for the full terms.
