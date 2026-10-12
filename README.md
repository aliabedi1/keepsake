# Keepsake

Keepsake is a local Instagram highlight and post downloader for Windows and Linux.
Connect an Instagram account, choose **Highlights** or **Posts**, paste a profile
link, browse its media in Instagram order, and maintain a validated local copy that can be
exported as a ZIP whenever needed.

## Requirements

- Node.js 22.13.0 or newer, with npm
- Python 3

### Node.js 26 startup warning

Tailwind 4.3.3 uses `module.registerHooks()` on Node.js 26, avoiding the
`[DEP0205]` warning from older Tailwind versions. If the warning appears after
updating Keepsake, run `npm install` and restart the local server to load the
updated dependencies.

## Windows installation and usage

For the PowerShell launcher, Windows requires PowerShell and Python 3 available
as `python`. You can also use Git Bash with the Bash launcher described below.

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

### Windows with Git Bash

Install Python 3 for Windows with PATH enabled, then reopen Git Bash so it can
find the installation. From the project directory, run:

```bash
npm install
./start-local.sh
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The Bash launcher detects
Windows and uses `.venv/Scripts/python.exe`. When it needs to create the virtual
environment, it checks `python3`, `python`, and `py -3` in that order, skipping
commands that cannot run Python 3 with the `venv` module, including unusable
Windows Store aliases. Git Bash must also provide `sha256sum`.

Like the PowerShell launcher, it installs Python dependencies on first use and
when `requirements.txt` changes. Press `Ctrl+C` in Git Bash to stop Keepsake.

### V2Ray TUN mode

Use `http://127.0.0.1:3000` while TUN mode is enabled. The web server
binds to IPv4 loopback explicitly, avoiding VPN changes to `localhost`
resolution. Restart Keepsake after updating to apply the server setting.
The start scripts also bypass environment-configured proxies for local
addresses while preserving proxy settings for Instagram requests.

## Linux installation and usage

Linux requires Bash, Python 3, the Python `venv` module,
and `sha256sum`. On Debian and Ubuntu, you can install the operating-system
packages with:

```bash
sudo apt update
sudo apt install python3 python3-venv coreutils
```

The Bash launcher checks `python3`, `python`, and `py -3` in that order when
creating the virtual environment and uses the first working Python 3 interpreter
with the `venv` module.

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

Saved content for the selected mode appears in **Saved library** when Keepsake starts.
Choose a saved profile and highlight or post to browse or export downloaded files without an
Instagram login or internet connection. Keep the local app running so it can
serve the files from `downloads/`.

1. Click **Connect Instagram**.
2. Enter the Instagram username and password used to view the target profile.
3. If the account uses two-factor authentication, enter its current code when
   prompted.
4. Choose **Highlights** or **Posts**, paste the target profile link, and choose
   **Show highlights** or **Show posts**.
5. Select a highlight or post to preview its stories or media files.
6. Choose **Download stories** or **Download posts** to create the local copy.
   Use **Download post** inside a selected post to save just that post.
7. Use **Update account**, **Update highlight**, or **Update post** later to retrieve only files
   that are new, missing, or invalid.
8. Choose **Get saved ZIP** to export files that already exist locally.

Posts mode supports photo posts, videos, reels shown in the profile feed, and
every photo or video in a carousel. Carousel files keep their slide order and
the parent post's timestamp. Post captions are kept in the local manifest and
shown in the preview. Highlights and posts have separate saved libraries and
ZIP exports; switching modes keeps the same Instagram login.

A highlight is a collection of stories. A post is a feed entry with one or more
media files: a three-slide carousel counts as **1 post · 3 files**, while a
highlight containing three stories counts as **1 highlight · 3 stories**.
Each mode has its own definitions, API responses, manifests, and counts.
See [the glossary](CONTEXT.md) for the terms used throughout Keepsake.

When you are browsing a connected profile, switching modes loads that same
profile's highlights or posts automatically. The app rejects content returned
for the wrong mode, so a highlight cannot appear as a post.

After an app update, restart the start script and refresh the browser. The Python
backend does not reload automatically. If an older backend is still running,
Keepsake shows a restart message and disables online downloads until the service
is updated. Reconnect Instagram after restarting; saved files remain available.

Post browsing calculates the full page count from Instagram's profile post count
before displaying the first page. It fetches previews on demand and reuses pages
already loaded in this session. The media-file count is labeled **loaded files**
until the full feed has been fetched. When the feed ends, its actual post count
replaces the profile count if Instagram's metadata was outdated.
**Download posts** and **Update account** scan the complete profile feed in the
background before saving files, including posts you have not browsed yet.
**Continue download** retries missing or invalid files across the complete feed;
while browsing a partial feed, its remaining count covers the loaded posts.

The persistent local library has this structure:

```text
downloads/
└── username__ig_123/
    ├── account.json
    ├── posts/
    │   └── 001__Post 20260806T091425Z__ig_321/
    │       ├── manifest.json
    │       ├── current/
    │       │   ├── 0001__20260806T091425Z__ig_654.jpg
    │       │   └── 0002__20260806T091425Z__ig_655.mp4
    │       ├── removed/
    │       └── corrupt/
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

Keepsake uses Instagram's authenticated private/mobile highlight and profile-feed endpoints. A
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

Login uses instagrapi's current CAA flow and HTTP/2 mobile transport. If login
fails with `UnknownError` or an outdated-client notice, stop Keepsake and restart
it with `start-local.ps1` (Windows) or `start-local.sh` (Linux) to install the
pinned dependencies. Complete any account verification in the official
Instagram app or website before reconnecting; avoid repeated login attempts.

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
