# Keepsake

Keepsake is a local Instagram highlight downloader for Windows and Linux.
Connect an Instagram account, paste a profile link, browse its highlight
stories in Instagram order, and maintain a validated local copy that can be
exported as a ZIP whenever needed.

## Requirements

- Node.js 22.13.0 or newer, with npm
- Python 3

## Windows installation and usage

Windows requires PowerShell and Python available as `python`.

1. Install the JavaScript dependencies:

   ```powershell
   npm install
   ```

2. Start Keepsake:

   ```powershell
   .\start-local.ps1
   ```

   You can also right-click `start-local.ps1` and choose **Run with
   PowerShell**.

3. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

The start script creates `.venv/` on the first run and updates the Python
packages whenever `requirements.txt` changes. Press `Ctrl+C` in the PowerShell
window to stop Keepsake.

### V2Ray TUN mode

Use `http://127.0.0.1:3000` while TUN mode is enabled. The web server
binds to IPv4 loopback explicitly, avoiding VPN changes to `localhost`
resolution. Restart Keepsake after updating to apply the server setting.
The start scripts also bypass environment-configured proxies for local
addresses while preserving proxy settings for Instagram requests.

## Linux installation and usage

Linux requires Bash, Python available as `python3`, the Python `venv` module,
and `sha256sum`. On Debian and Ubuntu, you can install the operating-system
packages with:

```bash
sudo apt update
sudo apt install python3 python3-venv coreutils
```

Then install and start Keepsake:

1. Install the JavaScript dependencies:

   ```bash
   npm install
   ```

2. Make the start script executable and run it:

   ```bash
   chmod +x start-local.sh
   ./start-local.sh
   ```

3. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

The start script creates `.venv/` on the first run and updates the Python
packages whenever `requirements.txt` changes. Press `Ctrl+C` in the terminal
to stop Keepsake.

## Use

Saved highlights appear in **Saved library** when Keepsake starts. Choose a
saved profile and highlight to browse or export downloaded stories without an
Instagram login or internet connection. Keep the local app running so it can
serve the files from `downloads/`.

1. Click **Connect Instagram**.
2. Enter the Instagram username and password used to view the target profile.
3. If the account uses two-factor authentication, enter its current code when
   prompted.
4. Paste the target profile link and choose **Show highlights**.
5. Select a highlight to browse its stories.
6. Choose **Download stories** to create the local copy.
7. Use **Update account** or **Update highlight** later to retrieve only files
   that are new, missing, or invalid.
8. Choose **Get saved ZIP** to export files that already exist locally.

The persistent local library has this structure:

```text
downloads/
└── username__ig_123/
    ├── account.json
    └── highlights/
        └── 001__Highlight name__ig_456/
            ├── manifest.json
            ├── current/
            │   ├── 0001__20260806T091425Z__ig_789.jpg
            │   └── 0002__20260806T094102Z__ig_790.mp4
            ├── removed/
            └── corrupt/
```

## How it works

The platform start script (`start-local.ps1` on Windows or `start-local.sh` on
Linux) starts the local Python backend at
`http://127.0.0.1:8787` and the web interface at
`http://127.0.0.1:3000`. The browser sends requests to the local backend,
which creates the authenticated Instagram session and retrieves highlight
metadata and media.

Keepsake uses Instagram's authenticated private/mobile highlight endpoint. A
profile scan is normalized once and cached in memory for the active browser
session. Opening stories or preparing a ZIP reuses that scan instead of
repeating the profile and highlight lookup, reducing duplicate requests that
could trigger immediate `429` responses.

When an update begins, the backend compares Instagram media IDs with the local
manifest. Valid existing files are reused, reordered files are renamed without
being downloaded again, and missing or invalid files are fetched with automatic
retries and partial-file resume support. Media removed from Instagram is kept in
the highlight's `removed/` directory rather than deleted.

The filename contains the current Instagram position, the story timestamp in
UTC, and the stable Instagram media ID. Position preserves visible order while
the ID lets later updates recognize the same story even if its position changes.
ZIP exports are generated only from validated local files and do not contact
Instagram.

A downloaded highlight is marked **Old** when it has not been checked for 24
hours. The badge indicates that an update is recommended; it does not mean the
remote highlight definitely changed.

### Session and credential handling

Instagram credentials are handled only by the local backend. The password is
discarded immediately after login. Authenticated client data, cached profile
data and temporary Instagram media links remain in memory only and are removed
when you disconnect or after the browser stops sending its heartbeat. Downloaded
media and non-sensitive library manifests persist under `downloads/`. Login
credentials and authenticated session data are never written there.

## Notes

- Use this only for content you own or have permission to save.
- Instagram can still restrict an account, IP address, or request pattern. If
  it asks you to slow down or verify the account, stop retrying and use the
  official Instagram app or website before reconnecting.
- Keepsake is an unofficial local tool and is not affiliated with Instagram.
