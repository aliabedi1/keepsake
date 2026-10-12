"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import ThemeSelector from "./theme-selector";

const API = "http://127.0.0.1:8787/api";
const SESSION_KEY = "keepsake-browser-session";
const BACKEND_UPDATE_MESSAGE = "The local service is an older version. Restart Keepsake with start-local.ps1 (Windows) or start-local.sh (Linux), then reconnect Instagram.";
type ContentMode = "highlights" | "posts";

type CollectionSummary = {
  id: string;
  title: string;
  cover_url: string;
  item_count: number;
  position: number;
  local_status: "not_downloaded" | "partial" | "current" | "old";
  downloaded_count: number;
  removed_count: number;
  failed_count: number;
  last_updated_at: string;
  is_old: boolean;
  has_local: boolean;
};

type Highlight = CollectionSummary & { kind: "highlights" };
type Post = CollectionSummary & { kind: "posts"; caption: string; taken_at: string };
type LibraryEntry = Highlight | Post;

type Profile = {
  id: string;
  username: string;
  full_name: string;
  profile_pic_url: string;
  is_private: boolean;
  has_local: boolean;
  is_old: boolean;
  last_updated_at: string;
};

type PageInfo = {
  page: number;
  page_size: number;
  total_pages: number;
  has_more: boolean;
};

type HighlightScan = PageInfo & {
  mode: "highlights";
  profile: Profile & { downloaded_stories: number; undownloaded_stories: number; old_highlights: number };
  highlights: Highlight[];
  total_highlights: number;
  total_stories: number;
};

type PostScan = PageInfo & {
  mode: "posts";
  profile: Profile & { downloaded_files: number; undownloaded_files: number; old_posts: number };
  posts: Post[];
  total_posts: number;
  total_files: number;
};

// Shared presentation uses neutral units; API entities retain their own definitions.
type LibraryView = PageInfo & {
  mode: ContentMode;
  profile: Profile & { saved_files: number; missing_files: number; old_collections: number };
  entries: LibraryEntry[];
  total_entries: number;
  total_files: number;
};

type MediaFile = {
  id: string;
  position: number;
  type: "image" | "video";
  filename: string;
  source_url: string;
  preview_url: string;
  download_url: string;
  local_available: boolean;
  taken_at: string;
  removed_from_instagram?: boolean;
};

type SavedAccount = {
  id: string;
  username: string;
  full_name: string;
  saved_files: number;
  saved_entries: number;
};

type StoryResult = { highlight: Highlight; stories: MediaFile[] };
type PostMediaResult = { post: Post; files: MediaFile[] };

type DownloadJob = {
  status: "working" | "complete" | "partial" | "error";
  completed_collections: number;
  total_collections: number;
  current_collection: string;
  current_file: number;
  current_file_total: number;
  downloaded_items: number;
  reused_items: number;
  failed_items: number;
  errors: string[];
  error: string;
};

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle className="dot" cx="17.4" cy="6.7" r="1" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5h7l2-2h9v14H3z" />
    </svg>
  );
}

function localStatusLabel(highlight: LibraryEntry) {
  if (highlight.local_status === "partial") {
    return `${highlight.downloaded_count}/${highlight.item_count} saved`;
  }
  if (highlight.local_status === "current") return "Saved locally";
  if (highlight.local_status === "old") return "Old · update";
  return "Not downloaded";
}

function updateActionLabel(highlight: LibraryEntry, mode: ContentMode) {
  if (!highlight.has_local) return mode === "posts" ? "Download post" : "Download stories";
  if (highlight.local_status === "partial") return mode === "posts" ? "Get missing files" : "Get missing stories";
  return mode === "posts" ? "Update post" : "Update highlight";
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 90000);
  try {
    const sessionToken = window.sessionStorage.getItem(SESSION_KEY);
    const headers = new Headers(options?.headers);
    if (options?.body) headers.set("Content-Type", "application/json");
    if (sessionToken) headers.set("X-Keepsake-Session", sessionToken);
    const response = await fetch(`${API}${path}`, {
      ...options,
      signal: options?.signal || controller.signal,
      headers,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(data.detail || "Something went wrong.", response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        "Instagram did not respond within 90 seconds. The request was stopped; wait before trying again.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function scanApi(mode: ContentMode, path: string, options?: RequestInit): Promise<LibraryView> {
  const data = await api<HighlightScan | PostScan>(path, options);
  if (data.mode !== mode) throw new Error(BACKEND_UPDATE_MESSAGE);
  if (data.mode === "posts") {
    if (!Array.isArray(data.posts) || data.posts.some((post) => post.kind !== "posts")) throw new Error(BACKEND_UPDATE_MESSAGE);
    return {
      ...data,
      entries: data.posts,
      total_entries: data.total_posts,
      total_files: data.total_files,
      profile: { ...data.profile, saved_files: data.profile.downloaded_files, missing_files: data.profile.undownloaded_files, old_collections: data.profile.old_posts },
    };
  }
  if (!Array.isArray(data.highlights) || data.highlights.some((highlight) => highlight.kind !== "highlights")) throw new Error(BACKEND_UPDATE_MESSAGE);
  return {
    ...data,
    entries: data.highlights,
    total_entries: data.total_highlights,
    total_files: data.total_stories,
    profile: { ...data.profile, saved_files: data.profile.downloaded_stories, missing_files: data.profile.undownloaded_stories, old_collections: data.profile.old_highlights },
  };
}

async function savedAccountsApi(mode: ContentMode): Promise<SavedAccount[]> {
  type AccountSummary = Pick<SavedAccount, "id" | "username" | "full_name"> & {
    downloaded_stories?: number; saved_highlights?: number;
    downloaded_files?: number; saved_posts?: number;
  };
  const data = await api<{ mode: ContentMode; accounts: AccountSummary[] }>(`/library?mode=${mode}`);
  if (data.mode !== mode) throw new Error(BACKEND_UPDATE_MESSAGE);
  return data.accounts.map((account) => ({
    id: account.id, username: account.username, full_name: account.full_name,
    saved_files: (mode === "posts" ? account.downloaded_files : account.downloaded_stories) ?? 0,
    saved_entries: (mode === "posts" ? account.saved_posts : account.saved_highlights) ?? 0,
  }));
}

export default function Home() {
  const [contentMode, setContentMode] = useState<ContentMode>("highlights");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const detailRequest = useRef(0);
  const modeProfile = useRef<{ username: string; id: string; source: "saved" | "instagram" } | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [target, setTarget] = useState("");
  const [viewer, setViewer] = useState("");
  const [scan, setScan] = useState<LibraryView | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [libraryMode, setLibraryMode] = useState<"saved" | "instagram">("saved");
  const [selectedEntry, setSelectedEntry] = useState<LibraryEntry | null>(null);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState("");
  const [downloadError, setDownloadError] = useState<{ target: string; message: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "error">("idle");
  const [message, setMessage] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [collectionPage, setCollectionPage] = useState(1);
  const [pageLoading, setPageLoading] = useState(false);
  const isPosts = contentMode === "posts";
  const collectionLabel = isPosts ? "posts" : "highlights";
  const itemLabel = isPosts ? "files" : "stories";
  const busy = status === "scanning" || pageLoading || mediaLoading || downloadTarget !== null || libraryLoading;

  const totalPages = scan?.total_pages ?? 0;
  const missingFiles = scan?.profile.missing_files ?? 0;
  const canContinueDownload = Boolean(scan?.profile.has_local && missingFiles > 0);
  const firstVisibleEntry = scan
    ? (scan.page - 1) * scan.page_size
    : 0;
  const visibleEntries = scan?.entries ?? [];
  const visiblePageNumbers = totalPages <= 7
    ? Array.from({ length: totalPages }, (_, index) => index + 1)
    : Array.from(new Set([
        1,
        Math.max(2, collectionPage - 1),
        collectionPage,
        Math.min(totalPages - 1, collectionPage + 1),
        totalPages,
      ])).sort((first, second) => first - second);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{ connected: boolean; username: string | null; api_version: number }>("/status");
      if (data.api_version !== 5) {
        setBackendReady(false);
        setMessage(BACKEND_UPDATE_MESSAGE);
        return;
      }
      setBackendReady(true);
      setViewer(data.connected ? data.username || "" : "");
      if (!data.connected) window.sessionStorage.removeItem(SESSION_KEY);
      setMessage("");
    } catch {
      setMessage("The local download service is not running. Start the app with start-local.ps1.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(refreshStatus, 0);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  useEffect(() => {
    let active = true;
    const requestedProfile = modeProfile.current;
    savedAccountsApi(contentMode)
      .then(async (accounts) => {
        if (!active) return;
        setSavedAccounts(accounts);
        if (requestedProfile?.source === "instagram") {
          const remote = await scanApi(contentMode, `/${contentMode}/scan`, {
            method: "POST", body: JSON.stringify({ target_username: requestedProfile.username }),
          });
          if (active) {
            setScan(remote);
            setLibraryMode("instagram");
            setStatus("idle");
          }
        } else {
          const account = accounts.find((item) => item.id === requestedProfile?.id) ?? accounts[0];
          if (account) {
            const local = await scanApi(contentMode, `/library/${account.id}?mode=${contentMode}`);
            if (active) setScan((current) => current ?? local);
          }
        }
      })
      .catch((error) => {
        if (active) {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Could not load the selected library.");
        }
      })
      .finally(() => { if (active) setLibraryLoading(false); });
    return () => { active = false; };
  }, [contentMode]);

  function changeMode(mode: ContentMode) {
    if (mode === contentMode || busy) return;
    detailRequest.current += 1;
    modeProfile.current = scan ? {
      username: scan.profile.username,
      id: scan.profile.id,
      source: viewer && backendReady ? "instagram" : libraryMode,
    } : null;
    setContentMode(mode);
    setLibraryLoading(true);
    setSavedAccounts([]);
    setScan(null);
    setLibraryMode("saved");
    setSelectedEntry(null);
    setMediaFiles([]);
    setCollectionPage(1);
    setDownloadError(null);
    setMessage("");
    setStatus(modeProfile.current?.source === "instagram" ? "scanning" : "idle");
  }

  useEffect(() => {
    if (!viewer) return;
    const heartbeat = () => api("/session/heartbeat", { method: "POST" }).catch(() => setViewer(""));
    const timer = window.setInterval(heartbeat, 45_000);
    return () => window.clearInterval(timer);
  }, [viewer]);

  async function handleScan(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    detailRequest.current += 1;
    setStatus("scanning");
    setMessage("");
    setScan(null);
    setDownloadTarget(null);
    setDownloadError(null);
    setCollectionPage(1);
    setSelectedEntry(null);
    setMediaFiles([]);
    try {
      const data = await scanApi(contentMode, `/${contentMode}/scan`, {
        method: "POST",
        body: JSON.stringify({
          target_username: target,
          mode: contentMode,
        }),
      });
      setScan(data);
      setLibraryMode("instagram");
      setCollectionPage(data.page);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : `Could not load ${collectionLabel}.`);
    }
  }

  async function loadMedia(highlight: LibraryEntry, profileUsername?: string) {
    const requestId = ++detailRequest.current;
    setSelectedEntry(highlight);
    setMediaFiles([]);
    setMediaLoading(true);
    setMessage("");
    try {
      const path = libraryMode === "saved"
        ? `/library/${scan?.profile.id}/${contentMode}/${highlight.id}`
        : isPosts ? "/posts/media" : "/highlights/stories";
      const data = await api<StoryResult | PostMediaResult>(path, libraryMode === "saved" ? undefined : {
        method: "POST",
        body: JSON.stringify({
          target_username: profileUsername || scan?.profile.username || target,
          ...(isPosts ? { post_id: highlight.id } : { highlight_id: highlight.id }),
        }),
      });
      if (isPosts ? !("post" in data) : !("highlight" in data)) throw new Error(BACKEND_UPDATE_MESSAGE);
      const result = "post" in data
        ? { entry: data.post, files: data.files }
        : { entry: data.highlight, files: data.stories };
      if (requestId !== detailRequest.current) return;
      const updatedEntry = {
        ...result.entry,
        cover_url: highlight.cover_url || result.entry.cover_url,
      };
      setSelectedEntry(updatedEntry);
      setScan((current) => {
        if (!current) return current;
        const previous = current.entries.find((item) => item.id === updatedEntry.id);
        if (!previous) return current;
        return {
          ...current,
          total_files: current.total_files - previous.item_count + updatedEntry.item_count,
          entries: current.entries.map((item) => (
            item.id === updatedEntry.id ? updatedEntry : item
          )),
        };
      });
      setMediaFiles(result.files);
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      setMessage(
        error instanceof Error ? error.message : `Could not open that ${isPosts ? "post" : "highlight"}.`,
      );
    } finally {
      if (requestId === detailRequest.current) setMediaLoading(false);
    }
  }

  async function connectSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = loginName.trim();
    const code = verificationCode.trim();

    if (loginLoading || !username || !loginPassword) return;
    if (needsTwoFactor && !/^(?:\d{6}|\d{8})$/.test(code)) return;

    setLoginLoading(true);
    setMessage("");
    try {
      const data = await api<{ session_token: string; username: string }>("/session/login", {
        method: "POST",
        body: JSON.stringify({
          username,
          password: loginPassword,
          verification_code: code,
        }),
      });
      window.sessionStorage.setItem(SESSION_KEY, data.session_token);
      setViewer(data.username);
      setLoginPassword("");
      setVerificationCode("");
      setNeedsTwoFactor(false);
      setMessage(`Connected as @${data.username}. Login data stays in memory only while this tab is active.`);
      setLoginOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNeedsTwoFactor(true);
      }
      setMessage(error instanceof Error ? error.message : "Could not open login.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function changeCollectionPage(page: number) {
    if (
      !scan
      || pageLoading
      || downloadTarget !== null
      || mediaLoading
      || page === collectionPage
      || page < 1
      || page > totalPages
    ) return;

    setPageLoading(true);
    setMessage("");
    setSelectedEntry(null);
    setMediaFiles([]);
    try {
      const data = libraryMode === "saved"
        ? await scanApi(contentMode, `/library/${scan.profile.id}?page=${page}&mode=${contentMode}`)
        : await scanApi(contentMode, `/${contentMode}/page`, {
            method: "POST",
            body: JSON.stringify({
              target_username: scan.profile.username,
              page,
              mode: contentMode,
            }),
          });
      setScan(data);
      setCollectionPage(data.page);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load that highlight page.",
      );
    } finally {
      setPageLoading(false);
    }
  }

  function closeLogin() {
    setLoginOpen(false);
    setLoginPassword("");
    setVerificationCode("");
    setNeedsTwoFactor(false);
  }

  async function disconnectSession() {
    try {
      await api("/session", { method: "DELETE" });
    } finally {
      window.sessionStorage.removeItem(SESSION_KEY);
      setViewer("");
      if (libraryMode === "instagram") setScan(null);
      setSelectedEntry(null);
      setMediaFiles([]);
      setDownloadTarget(null);
      setDownloadError(null);
      setMessage("Instagram session removed from memory.");
    }
  }

  async function startDownload(
    highlightId: string | null = null,
    undownloadedOnly = false,
  ) {
    if (!scan || downloadTarget || !backendReady || mediaLoading || pageLoading) return;
    const requestedTarget = highlightId
      ? `entry:${highlightId}`
      : "all";

    setDownloadTarget(requestedTarget);
    setDownloadProgress(undownloadedOnly ? `Finding missing ${itemLabel}…` : "Checking Instagram…");
    setDownloadError(null);
    setMessage("");
    try {
      const data = await api<{ job_id: string }>(isPosts ? "/posts/sync" : "/library/sync", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          ...(isPosts ? { post_id: highlightId } : { highlight_id: highlightId }),
          undownloaded_only: undownloadedOnly,
          mode: contentMode,
        }),
      });
      let job: DownloadJob;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        job = await api<DownloadJob>(`/jobs/${data.job_id}`);
        if (job.status === "error") {
          throw new Error(job.error || "The local library could not be updated.");
        }
        if (job.status === "working") {
          setDownloadProgress(
            job.current_file_total
              ? `${job.current_file}/${job.current_file_total} · ${isPosts ? "post" : "highlight"} ${job.completed_collections + 1}/${job.total_collections}`
              : job.total_collections
                ? job.current_collection.startsWith("Finding posts:") ? job.current_collection : `Checking ${job.completed_collections + 1} of ${job.total_collections} ${collectionLabel}…`
                : "Refreshing account…",
          );
        }
      } while (job.status === "working");

      const refreshed = await scanApi(contentMode, `/${contentMode}/page`, {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          page: collectionPage,
          mode: contentMode,
        }),
      });
      setScan(refreshed);
      const saved = await savedAccountsApi(contentMode);
      setSavedAccounts(saved);
      const refreshedEntry = selectedEntry
        ? refreshed.entries.find((item) => item.id === selectedEntry.id)
        : null;
      if (refreshedEntry) await loadMedia(refreshedEntry, refreshed.profile.username);
      const summary = `${job.downloaded_items} downloaded · ${job.reused_items} already valid`;
      if (job.status === "partial") {
        setDownloadError({
          target: requestedTarget,
          message: job.errors?.[0] || job.error || `Some missing ${itemLabel} could not be downloaded.`,
        });
      }
      setMessage(
        job.status === "partial"
          ? `${summary} · ${job.failed_items} failed. Continue the download to retry missing files.`
          : `${summary}. Your local library is up to date.`,
      );
    } catch (error) {
      setDownloadError({
        target: requestedTarget,
        message: error instanceof Error ? error.message : "The local update could not start.",
      });
    } finally {
      setDownloadTarget(null);
      setDownloadProgress("");
    }
  }

  function exportSaved(highlightId?: string) {
    if (!scan?.profile.has_local) return;
    const url = new URL(`${API}/library/${scan.profile.id}/export`);
    url.searchParams.set("mode", contentMode);
    if (highlightId) url.searchParams.set("highlight_id", highlightId);
    const link = document.createElement("a");
    link.href = url.toString();
    link.download = "";
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function openSavedAccount(accountId: string) {
    if (busy) return;
    setLibraryLoading(true);
    setMessage("");
    try {
      const local = await scanApi(contentMode, `/library/${accountId}?mode=${contentMode}`);
      setScan(local);
      setLibraryMode("saved");
      setCollectionPage(1);
      setSelectedEntry(null);
      setMediaFiles([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the saved profile.");
    } finally {
      setLibraryLoading(false);
    }
  }

  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="brand" href="#" aria-label="Keepsake home">
          <span className="brand-mark"><InstagramIcon /></span>
          keepsake
        </a>
        <div className="nav-actions">
          <ThemeSelector />
          <span className="local-badge"><span /> {viewer ? `Connected @${viewer}` : savedAccounts.length ? "Offline library ready" : "Login required"}</span>
        </div>
      </nav>

      <section className="hero local-hero">
        <div className="eyebrow"><span className="eyebrow-icon">✦</span>INSTAGRAM {isPosts ? "POST" : "HIGHLIGHT"} ARCHIVER</div>
        {savedAccounts.length ? (
          <>
            <h1>Your saved {isPosts ? "posts" : "stories"}.<br /><em>Ready offline.</em></h1>
            <p className="intro">Browse your downloaded {collectionLabel} without logging in. Connect Instagram only when you want to find or update {collectionLabel}.</p>
            <a className="offline-shortcut" href="#saved-library-title">
              Browse {savedAccounts.length} saved {savedAccounts.length === 1 ? "profile" : "profiles"} <span aria-hidden="true">↓</span>
            </a>
          </>
        ) : (
          <>
            <h1>One profile.<br /><em>Every {isPosts ? "post" : "highlight"}.</em></h1>
            <p className="intro">
              {isPosts
                ? "Browse photos, videos, reels, and carousels from a profile, then save every file into clean, named folders on your computer."
                : "See highlights exactly as they’re organized on Instagram, then save every story into clean, named folders on your computer."}
            </p>
          </>
        )}

        <div className="content-mode" role="group" aria-label="Content to download">
          <button type="button" aria-pressed={!isPosts} disabled={busy} onClick={() => changeMode("highlights")}>Highlights</button>
          <button type="button" aria-pressed={isPosts} disabled={busy} onClick={() => changeMode("posts")}>Posts</button>
        </div>

        <form className="username-form" onSubmit={handleScan}>
          <div className="username-field">
            <label htmlFor="target">Instagram profile link</label>
            <div className="username-input">
              <span>↗</span>
              <input
                id="target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="https://www.instagram.com/natgeo/"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="session-field">
            <label>Instagram session</label>
            {viewer ? (
              <div className="connected-account">
                <span>●</span>
                <strong>@{viewer}</strong>
              </div>
            ) : (
              <button type="button" className="login-inline" onClick={() => setLoginOpen(true)}>
                Connect Instagram
              </button>
            )}
          </div>
          <button className="scan-button" type="submit" disabled={!target || !viewer || !backendReady || busy}>
            {status === "scanning" ? `Finding ${collectionLabel}…` : `Show ${collectionLabel}`}
            {status !== "scanning" && <span>→</span>}
          </button>
        </form>

        <div className="connect-line">
          <span>Your Instagram login exists only in memory while this tab stays active.</span>
          {viewer ? (
            <button type="button" disabled={busy} onClick={disconnectSession}>Disconnect</button>
          ) : (
            <button type="button" onClick={() => setLoginOpen(true)}>Connect account</button>
          )}
        </div>

        {message && (
          <div className={`status-card ${status === "error" ? "error-card" : "info-card"}`} role="status">
            <span>{status === "error" ? "!" : "i"}</span>
            <p>{message}</p>
          </div>
        )}
      </section>

      {savedAccounts.length > 0 && (
        <section className="saved-library" aria-labelledby="saved-library-title">
          <div>
            <span className="section-number">ON THIS COMPUTER</span>
            <h2 id="saved-library-title">Saved library</h2>
            <p>Browse downloaded {collectionLabel} and {itemLabel} without connecting to Instagram.</p>
          </div>
          <div className="saved-account-list">
            {savedAccounts.map((account) => (
              <button
                type="button"
                key={account.id}
                className={libraryMode === "saved" && scan?.profile.id === account.id ? "active" : ""}
                disabled={busy}
                onClick={() => openSavedAccount(account.id)}
              >
                <strong>@{account.username}</strong>
                <span>{account.saved_entries.toLocaleString("en-US")} {collectionLabel} · {account.saved_files.toLocaleString("en-US")} saved {itemLabel}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {scan && (
        <section className="library">
          <div className="profile-row">
            {scan.profile.profile_pic_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={scan.profile.profile_pic_url} alt="" className="profile-photo" referrerPolicy="no-referrer" />
            ) : (
              <span className="profile-photo profile-photo-fallback"><FolderIcon /></span>
            )}
            <div>
              <div className="profile-kicker-row">
                <span className="result-owner">@{scan.profile.username}</span>
                {scan.profile.has_local && (
                  <span className={`library-state ${scan.profile.is_old ? "is-old" : "is-current"}`}>
                    {libraryMode === "saved" ? "Saved on this computer" : scan.profile.is_old ? `${scan.profile.old_collections} old` : "Local copy ready"}
                  </span>
                )}
              </div>
              <h2>{scan.profile.full_name || scan.profile.username}</h2>
              <p>
                {libraryMode === "saved"
                  ? `${scan.total_entries} saved ${collectionLabel} · ${scan.total_files} saved ${itemLabel}`
                  : `${scan.total_entries}${scan.has_more ? "+" : ""} ${collectionLabel}${scan.has_more ? " loaded" : ""} · ${scan.total_files} ${itemLabel}${scan.profile.has_local ? ` · ${scan.profile.saved_files} saved locally` : ""}`}
              </p>
            </div>
            <div className="profile-download-control">
              <div className="profile-actions">
                {libraryMode === "instagram" && <button
                  type="button"
                  className="sync-button"
                  onClick={() => startDownload(null, canContinueDownload)}
                  disabled={(!scan.total_entries && !scan.profile.has_local) || !backendReady || busy}
                  aria-busy={downloadTarget === "all"}
                  aria-label={canContinueDownload
                    ? `Continue download. ${missingFiles} ${itemLabel} left in loaded ${collectionLabel}.`
                    : undefined}
                >
                  {downloadTarget === "all" ? (
                    <><span className="button-spinner" /> {downloadProgress}</>
                  ) : canContinueDownload ? (
                    <>
                      Continue download
                      <span className="remaining-count">{missingFiles.toLocaleString("en-US")} {scan.has_more ? "missing in loaded posts" : "left"}</span>
                      <span aria-hidden="true">↓</span>
                    </>
                  ) : scan.profile.has_local ? (
                    <>Update account <span aria-hidden="true">↻</span></>
                  ) : (
                    <>Download {isPosts ? "posts" : "stories"} <span aria-hidden="true">↓</span></>
                  )}
                </button>}
                <button
                  type="button"
                  className="export-button"
                  onClick={() => exportSaved()}
                  disabled={!scan.profile.has_local || downloadTarget !== null}
                >
                  Get saved ZIP <span aria-hidden="true">⇩</span>
                </button>
              </div>
              {downloadError?.target === "all" && (
                <p className="download-error" role="alert">{downloadError.message}</p>
              )}
            </div>
          </div>

          {scan.entries.length ? (
            <>
              {!selectedEntry && (
                <p className="highlight-tip">
                  <span aria-hidden="true">↓</span>
                  <strong>Choose a {isPosts ? "post" : "highlight"}</strong> to preview its {itemLabel}
                </p>
              )}
              <div className={`highlight-strip ${isPosts ? "post-grid" : ""}`} aria-busy={pageLoading}>
                {pageLoading ? (
                  <div className="highlight-page-loading" role="status">
                    <span className="loader" />
                    Loading {isPosts ? "post" : "highlight"} page…
                  </div>
                ) : visibleEntries.map((highlight) => (
                    <button
                      type="button"
                      className={`highlight-card ${selectedEntry?.id === highlight.id ? "selected" : ""}`}
                      key={highlight.id}
                      onClick={() => loadMedia(highlight)}
                      disabled={pageLoading || downloadTarget !== null}
                      aria-pressed={selectedEntry?.id === highlight.id}
                    >
                      <span className="highlight-ring">
                        {highlight.cover_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={highlight.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : <span className="highlight-cover-fallback"><FolderIcon /></span>}
                        <i>{selectedEntry?.id === highlight.id ? "●" : ""}</i>
                      </span>
                      <strong>{highlight.title}</strong>
                      <small>{highlight.item_count} {isPosts ? highlight.item_count === 1 ? "file" : "files" : "stories"}</small>
                      <span className={`highlight-state state-${highlight.local_status}`}>
                        {localStatusLabel(highlight)}
                      </span>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div className="empty-highlights">{libraryMode === "saved" ? `No ${collectionLabel} are saved for this profile yet.` : `This profile has no visible ${collectionLabel}.`}</div>
          )}

          {totalPages > 1 && (
            <nav className="highlight-pagination" aria-label={`${isPosts ? "Post" : "Highlight"} pages`}>
              <button
                type="button"
                onClick={() => changeCollectionPage(collectionPage - 1)}
                disabled={busy || collectionPage === 1}
              >
                Previous
              </button>
              <div className="highlight-pages">
                {visiblePageNumbers.map((page, index) => (
                  <span className="highlight-page-control" key={page}>
                    {index > 0 && page - visiblePageNumbers[index - 1] > 1 && (
                      <span className="page-ellipsis" aria-hidden="true">…</span>
                    )}
                    <button
                      type="button"
                      className={page === collectionPage ? "active" : ""}
                      onClick={() => changeCollectionPage(page)}
                      disabled={busy}
                      aria-label={`Page ${page}`}
                      aria-current={page === collectionPage ? "page" : undefined}
                    >
                      {page}
                    </button>
                  </span>
                ))}
              </div>
              <span>
                {firstVisibleEntry + 1}–{Math.min(firstVisibleEntry + scan.page_size, scan.total_entries)} of {scan.total_entries}{scan.has_more ? "+" : ""}
              </span>
              <button
                type="button"
                onClick={() => changeCollectionPage(collectionPage + 1)}
                disabled={busy || collectionPage === totalPages}
              >
                Next
              </button>
            </nav>
          )}

          {selectedEntry && (
            <div className={`story-browser ${isPosts ? "post-browser" : ""}`}>
              <div className="story-browser-head">
                <div>
                  <span className="result-owner">SELECTED {isPosts ? "POST" : "HIGHLIGHT"}</span>
                  <h3>{selectedEntry.title}</h3>
                  <p>{selectedEntry.item_count} {libraryMode === "saved" ? `saved ${itemLabel}` : `${itemLabel} in Instagram order`}</p>
                  {isPosts && (selectedEntry.kind === "posts" ? selectedEntry.caption : "") && <p className="post-caption">{(selectedEntry.kind === "posts" ? selectedEntry.caption : "")}</p>}
                </div>
                <div className="story-browser-actions">
                  <span className="order-note">1 → {selectedEntry.item_count}</span>
                  {libraryMode === "instagram" && <button
                    type="button"
                    onClick={() => startDownload(selectedEntry.id)}
                    disabled={!backendReady || busy}
                    aria-busy={downloadTarget === `entry:${selectedEntry.id}`}
                  >
                    {downloadTarget === `entry:${selectedEntry.id}` ? (
                      <><span className="button-spinner" /> {downloadProgress}</>
                    ) : (
                      <>{updateActionLabel(selectedEntry, contentMode)} <span>↓</span></>
                    )}
                  </button>}
                  {selectedEntry.has_local && (
                    <button
                      type="button"
                      className="story-export-button"
                      onClick={() => exportSaved(selectedEntry.id)}
                      disabled={downloadTarget !== null}
                    >
                      Get ZIP <span>⇩</span>
                    </button>
                  )}
                  {downloadError?.target === `entry:${selectedEntry.id}` && (
                    <p className="download-error" role="alert">{downloadError.message}</p>
                  )}
                </div>
              </div>

              {mediaLoading ? (
                <div className="stories-loading">
                  <span className="loader" />
                  Loading {itemLabel}…
                </div>
              ) : (
                <div className="story-grid">
                  {mediaFiles.map((story) => (
                    <article className="story-card" key={story.id}>
                      <div className="story-media">
                        {story.type === "video" ? (
                          <video
                            src={story.source_url}
                            controls
                            preload="metadata"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={story.source_url}
                            alt={`${selectedEntry.title} ${isPosts ? "file" : "story"} ${story.position}`}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        )}
                        <span className="story-number">{story.position}</span>
                        <span className="story-type">{story.type}</span>
                        {story.removed_from_instagram && <span className="story-removed">Removed from Instagram</span>}
                      </div>
                      <div className="story-card-foot">
                        <span title={story.filename}>{story.filename}</span>
                        {story.local_available ? (
                          <a href={story.download_url} download={story.filename}>
                            Get file <b>↓</b>
                          </a>
                        ) : (
                          <em>Not saved</em>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="folder-preview">
            <div className="folder-tree">
              <span className="folder-icon"><FolderIcon /></span>
              <div>
                <strong>{scan.profile.username}/</strong>
                <p>
                  {scan.profile.saved_files} saved files · ordered, timestamped, ID-matched
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="structure-section">
        <div>
          <span className="section-number">THE OUTPUT</span>
          <h2>Your library,<br />safe between updates.</h2>
          <p>{isPosts ? "Post files" : "Stories"} are validated and kept inside the project’s downloads folder. Updates match Instagram IDs, preserve order, and fetch only missing or invalid files.</p>
        </div>
        <pre aria-label="Example local library structure">{`downloads/
└── username__ig_123/
    └── ${collectionLabel}/
        └── 001__${isPosts ? "Post 20260806T091425Z" : "Travel"}__ig_456/
            └── current/
                ├── 0001__20260806T091425Z__ig_789.jpg
                └── 0002__20260806T094102Z__ig_790.mp4`}</pre>
      </section>

      {loginOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeLogin}>
          <form className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title" onSubmit={connectSession} onMouseDown={(event) => event.stopPropagation()}>
            <span className="modal-kicker">LOCAL SESSION</span>
            <h2 id="login-title">Connect Instagram</h2>
            <p>Your credentials are sent only to the local backend to create an Instagram session. The password is discarded after login; session data remains in memory until you disconnect, close this tab, or it becomes inactive.</p>
            <label htmlFor="login-username">Your Instagram username</label>
            <div className="username-input">
              <span>@</span>
              <input
                id="login-username"
                name="username"
                value={loginName}
                onChange={(event) => setLoginName(event.target.value.replace(/^@/, ""))}
                placeholder="your_account"
                autoFocus
                autoComplete="username"
                required
              />
            </div>
            <label htmlFor="login-password">Instagram password</label>
            <div className="username-input">
              <span>⌁</span>
              <input
                id="login-password"
                name="password"
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
            </div>
            {needsTwoFactor && (
              <>
                <label htmlFor="verification-code">Two-factor code</label>
                <div className="username-input">
                  <span>#</span>
                  <input
                    id="verification-code"
                    name="verification-code"
                    inputMode="numeric"
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="6-digit code or 8-digit backup code"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}|[0-9]{8}"
                    autoFocus
                    required
                  />
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="cancel" onClick={closeLogin}>Cancel</button>
              <button
                type="submit"
                className="connect"
                disabled={!loginName.trim() || !loginPassword || loginLoading || (needsTwoFactor && !/^(?:\d{6}|\d{8})$/.test(verificationCode))}
              >
                {loginLoading ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        </div>
      )}

      <footer>
        <a className="brand footer-brand" href="#"><span className="brand-mark"><InstagramIcon /></span>keepsake</a>
        <p>For personal use and content you have permission to save.</p>
        <span>Persistent local library · ZIP on demand</span>
      </footer>
    </main>
  );
}
