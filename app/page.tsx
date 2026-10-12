"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import ThemeSelector from "./theme-selector";

const API = "http://127.0.0.1:8787/api";
const SESSION_KEY = "keepsake-browser-session";
type ContentMode = "highlights" | "posts";

type Highlight = {
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
  caption?: string;
  taken_at?: string;
};

type ScanResult = {
  mode: ContentMode;
  has_more: boolean;
  profile: {
    id: string;
    username: string;
    full_name: string;
    profile_pic_url: string;
    is_private: boolean;
    downloaded_stories: number;
    undownloaded_stories: number;
    has_local: boolean;
    is_old: boolean;
    old_highlights: number;
    last_updated_at: string;
  };
  highlights: Highlight[];
  page: number;
  page_size: number;
  total_pages: number;
  total_highlights: number;
  total_stories: number;
};

type Story = {
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
  downloaded_stories: number;
};

type StoryResult = {
  highlight: Highlight;
  stories: Story[];
};

type DownloadJob = {
  status: "working" | "complete" | "partial" | "error";
  completed_highlights: number;
  total_highlights: number;
  current_highlight: string;
  current_story: number;
  current_story_total: number;
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

function localStatusLabel(highlight: Highlight) {
  if (highlight.local_status === "partial") {
    return `${highlight.downloaded_count}/${highlight.item_count} saved`;
  }
  if (highlight.local_status === "current") return "Saved locally";
  if (highlight.local_status === "old") return "Old · update";
  return "Not downloaded";
}

function updateActionLabel(highlight: Highlight, mode: ContentMode) {
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

export default function Home() {
  const [contentMode, setContentMode] = useState<ContentMode>("highlights");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const detailRequest = useRef(0);
  const [target, setTarget] = useState("");
  const [viewer, setViewer] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [libraryMode, setLibraryMode] = useState<"saved" | "instagram">("saved");
  const [activeHighlight, setActiveHighlight] = useState<Highlight | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
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
  const [highlightPage, setHighlightPage] = useState(1);
  const [highlightPageLoading, setHighlightPageLoading] = useState(false);
  const isPosts = contentMode === "posts";
  const collectionLabel = isPosts ? "posts" : "highlights";
  const itemLabel = isPosts ? "files" : "stories";
  const busy = status === "scanning" || highlightPageLoading || storiesLoading || downloadTarget !== null || libraryLoading;

  const totalHighlightPages = scan?.total_pages ?? 0;
  const undownloadedStories = scan?.profile.undownloaded_stories ?? 0;
  const canContinueDownload = Boolean(scan?.profile.has_local && undownloadedStories > 0);
  const firstVisibleHighlight = scan
    ? (scan.page - 1) * scan.page_size
    : 0;
  const visibleHighlights = scan?.highlights ?? [];
  const visiblePageNumbers = totalHighlightPages <= 7
    ? Array.from({ length: totalHighlightPages }, (_, index) => index + 1)
    : Array.from(new Set([
        1,
        Math.max(2, highlightPage - 1),
        highlightPage,
        Math.min(totalHighlightPages - 1, highlightPage + 1),
        totalHighlightPages,
      ])).sort((first, second) => first - second);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{ connected: boolean; username: string | null }>("/status");
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
    api<{ accounts: SavedAccount[] }>(`/library?mode=${contentMode}`)
      .then(async (data) => {
        if (!active) return;
        setSavedAccounts(data.accounts);
        if (data.accounts.length) {
          const local = await api<ScanResult>(`/library/${data.accounts[0].id}?mode=${contentMode}`);
          if (active) setScan((current) => current ?? local);
        }
      })
      .catch(() => {
        if (active) setMessage("Could not load the saved library.");
      })
      .finally(() => { if (active) setLibraryLoading(false); });
    return () => { active = false; };
  }, [contentMode]);

  function changeMode(mode: ContentMode) {
    if (mode === contentMode || busy) return;
    detailRequest.current += 1;
    setContentMode(mode);
    setLibraryLoading(true);
    setSavedAccounts([]);
    setScan(null);
    setLibraryMode("saved");
    setActiveHighlight(null);
    setStories([]);
    setHighlightPage(1);
    setDownloadError(null);
    setMessage("");
    setStatus("idle");
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
    setHighlightPage(1);
    setActiveHighlight(null);
    setStories([]);
    try {
      const data = await api<ScanResult>("/highlights/scan", {
        method: "POST",
        body: JSON.stringify({
          target_username: target,
          mode: contentMode,
        }),
      });
      setScan(data);
      setLibraryMode("instagram");
      setHighlightPage(data.page);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : `Could not load ${collectionLabel}.`);
    }
  }

  async function loadStories(highlight: Highlight, profileUsername?: string) {
    const requestId = ++detailRequest.current;
    setActiveHighlight(highlight);
    setStories([]);
    setStoriesLoading(true);
    setMessage("");
    try {
      const data = libraryMode === "saved"
        ? await api<StoryResult>(`/library/${scan?.profile.id}/highlights/${highlight.id}?mode=${contentMode}`)
        : await api<StoryResult>("/highlights/stories", {
            method: "POST",
            body: JSON.stringify({
              target_username: profileUsername || scan?.profile.username || target,
              highlight_id: highlight.id,
              mode: contentMode,
            }),
          });
      if (requestId !== detailRequest.current) return;
      const updatedHighlight = {
        ...data.highlight,
        cover_url: highlight.cover_url || data.highlight.cover_url,
      };
      setActiveHighlight(updatedHighlight);
      setScan((current) => {
        if (!current) return current;
        const previous = current.highlights.find((item) => item.id === updatedHighlight.id);
        if (!previous) return current;
        return {
          ...current,
          total_stories: current.total_stories - previous.item_count + updatedHighlight.item_count,
          highlights: current.highlights.map((item) => (
            item.id === updatedHighlight.id ? updatedHighlight : item
          )),
        };
      });
      setStories(data.stories);
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      setMessage(
        error instanceof Error ? error.message : `Could not open that ${isPosts ? "post" : "highlight"}.`,
      );
    } finally {
      if (requestId === detailRequest.current) setStoriesLoading(false);
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

  async function changeHighlightPage(page: number) {
    if (
      !scan
      || highlightPageLoading
      || downloadTarget !== null
      || storiesLoading
      || page === highlightPage
      || page < 1
      || page > totalHighlightPages
    ) return;

    setHighlightPageLoading(true);
    setMessage("");
    setActiveHighlight(null);
    setStories([]);
    try {
      const data = libraryMode === "saved"
        ? await api<ScanResult>(`/library/${scan.profile.id}?page=${page}&mode=${contentMode}`)
        : await api<ScanResult>("/highlights/page", {
            method: "POST",
            body: JSON.stringify({
              target_username: scan.profile.username,
              page,
              mode: contentMode,
            }),
          });
      setScan(data);
      setHighlightPage(data.page);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not load that highlight page.",
      );
    } finally {
      setHighlightPageLoading(false);
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
      setActiveHighlight(null);
      setStories([]);
      setDownloadTarget(null);
      setDownloadError(null);
      setMessage("Instagram session removed from memory.");
    }
  }

  async function startDownload(
    highlightId: string | null = null,
    undownloadedOnly = false,
  ) {
    if (!scan || downloadTarget) return;
    const requestedTarget = highlightId
      ? `highlight:${highlightId}`
      : "all";

    setDownloadTarget(requestedTarget);
    setDownloadProgress(undownloadedOnly ? `Finding missing ${itemLabel}…` : "Checking Instagram…");
    setDownloadError(null);
    setMessage("");
    try {
      const data = await api<{ job_id: string }>("/library/sync", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          highlight_id: highlightId,
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
            job.current_story_total
              ? `${job.current_story}/${job.current_story_total} · ${isPosts ? "post" : "highlight"} ${job.completed_highlights + 1}/${job.total_highlights}`
              : job.total_highlights
                ? job.current_highlight.startsWith("Finding posts:") ? job.current_highlight : `Checking ${job.completed_highlights + 1} of ${job.total_highlights} ${collectionLabel}…`
                : "Refreshing account…",
          );
        }
      } while (job.status === "working");

      const refreshed = await api<ScanResult>("/highlights/page", {
        method: "POST",
        body: JSON.stringify({
          target_username: scan.profile.username,
          page: highlightPage,
          mode: contentMode,
        }),
      });
      setScan(refreshed);
      const saved = await api<{ accounts: SavedAccount[] }>(`/library?mode=${contentMode}`);
      setSavedAccounts(saved.accounts);
      const refreshedActive = activeHighlight
        ? refreshed.highlights.find((item) => item.id === activeHighlight.id)
        : null;
      if (refreshedActive) await loadStories(refreshedActive, refreshed.profile.username);
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
      const local = await api<ScanResult>(`/library/${accountId}?mode=${contentMode}`);
      setScan(local);
      setLibraryMode("saved");
      setHighlightPage(1);
      setActiveHighlight(null);
      setStories([]);
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
          <button className="scan-button" type="submit" disabled={!target || !viewer || busy}>
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
                <span>{account.downloaded_stories.toLocaleString("en-US")} saved {itemLabel}</span>
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
                    {libraryMode === "saved" ? "Saved on this computer" : scan.profile.is_old ? `${scan.profile.old_highlights} old` : "Local copy ready"}
                  </span>
                )}
              </div>
              <h2>{scan.profile.full_name || scan.profile.username}</h2>
              <p>
                {libraryMode === "saved"
                  ? `${scan.total_highlights} saved ${collectionLabel} · ${scan.total_stories} saved ${itemLabel}`
                  : `${scan.total_highlights}${scan.has_more ? "+" : ""} ${collectionLabel}${scan.has_more ? " loaded" : ""} · ${scan.total_stories} ${itemLabel}${scan.profile.has_local ? ` · ${scan.profile.downloaded_stories} saved locally` : ""}`}
              </p>
            </div>
            <div className="profile-download-control">
              <div className="profile-actions">
                {libraryMode === "instagram" && <button
                  type="button"
                  className="sync-button"
                  onClick={() => startDownload(null, canContinueDownload)}
                  disabled={(!scan.total_highlights && !scan.profile.has_local) || downloadTarget !== null}
                  aria-busy={downloadTarget === "all"}
                  aria-label={canContinueDownload
                    ? `Continue download. ${undownloadedStories} ${itemLabel} left in loaded ${collectionLabel}.`
                    : undefined}
                >
                  {downloadTarget === "all" ? (
                    <><span className="button-spinner" /> {downloadProgress}</>
                  ) : canContinueDownload ? (
                    <>
                      Continue download
                      <span className="remaining-count">{undownloadedStories.toLocaleString("en-US")} {scan.has_more ? "missing in loaded posts" : "left"}</span>
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

          {scan.highlights.length ? (
            <>
              {!activeHighlight && (
                <p className="highlight-tip">
                  <span aria-hidden="true">↓</span>
                  <strong>Choose a {isPosts ? "post" : "highlight"}</strong> to preview its {itemLabel}
                </p>
              )}
              <div className={`highlight-strip ${isPosts ? "post-grid" : ""}`} aria-busy={highlightPageLoading}>
                {highlightPageLoading ? (
                  <div className="highlight-page-loading" role="status">
                    <span className="loader" />
                    Loading {isPosts ? "post" : "highlight"} page…
                  </div>
                ) : visibleHighlights.map((highlight) => (
                    <button
                      type="button"
                      className={`highlight-card ${activeHighlight?.id === highlight.id ? "selected" : ""}`}
                      key={highlight.id}
                      onClick={() => loadStories(highlight)}
                      disabled={highlightPageLoading || downloadTarget !== null}
                      aria-pressed={activeHighlight?.id === highlight.id}
                    >
                      <span className="highlight-ring">
                        {highlight.cover_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={highlight.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : <span className="highlight-cover-fallback"><FolderIcon /></span>}
                        <i>{activeHighlight?.id === highlight.id ? "●" : ""}</i>
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

          {totalHighlightPages > 1 && (
            <nav className="highlight-pagination" aria-label={`${isPosts ? "Post" : "Highlight"} pages`}>
              <button
                type="button"
                onClick={() => changeHighlightPage(highlightPage - 1)}
                disabled={busy || highlightPage === 1}
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
                      className={page === highlightPage ? "active" : ""}
                      onClick={() => changeHighlightPage(page)}
                      disabled={busy}
                      aria-label={`Page ${page}`}
                      aria-current={page === highlightPage ? "page" : undefined}
                    >
                      {page}
                    </button>
                  </span>
                ))}
              </div>
              <span>
                {firstVisibleHighlight + 1}–{Math.min(firstVisibleHighlight + scan.page_size, scan.total_highlights)} of {scan.total_highlights}{scan.has_more ? "+" : ""}
              </span>
              <button
                type="button"
                onClick={() => changeHighlightPage(highlightPage + 1)}
                disabled={busy || highlightPage === totalHighlightPages}
              >
                Next
              </button>
            </nav>
          )}

          {activeHighlight && (
            <div className={`story-browser ${isPosts ? "post-browser" : ""}`}>
              <div className="story-browser-head">
                <div>
                  <span className="result-owner">SELECTED {isPosts ? "POST" : "HIGHLIGHT"}</span>
                  <h3>{activeHighlight.title}</h3>
                  <p>{activeHighlight.item_count} {libraryMode === "saved" ? `saved ${itemLabel}` : `${itemLabel} in Instagram order`}</p>
                  {isPosts && activeHighlight.caption && <p className="post-caption">{activeHighlight.caption}</p>}
                </div>
                <div className="story-browser-actions">
                  <span className="order-note">1 → {activeHighlight.item_count}</span>
                  {libraryMode === "instagram" && <button
                    type="button"
                    onClick={() => startDownload(activeHighlight.id)}
                    disabled={downloadTarget !== null}
                    aria-busy={downloadTarget === `highlight:${activeHighlight.id}`}
                  >
                    {downloadTarget === `highlight:${activeHighlight.id}` ? (
                      <><span className="button-spinner" /> {downloadProgress}</>
                    ) : (
                      <>{updateActionLabel(activeHighlight, contentMode)} <span>↓</span></>
                    )}
                  </button>}
                  {activeHighlight.has_local && (
                    <button
                      type="button"
                      className="story-export-button"
                      onClick={() => exportSaved(activeHighlight.id)}
                      disabled={downloadTarget !== null}
                    >
                      Get ZIP <span>⇩</span>
                    </button>
                  )}
                  {downloadError?.target === `highlight:${activeHighlight.id}` && (
                    <p className="download-error" role="alert">{downloadError.message}</p>
                  )}
                </div>
              </div>

              {storiesLoading ? (
                <div className="stories-loading">
                  <span className="loader" />
                  Loading {itemLabel}…
                </div>
              ) : (
                <div className="story-grid">
                  {stories.map((story) => (
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
                            alt={`${activeHighlight.title} ${isPosts ? "file" : "story"} ${story.position}`}
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
                  {scan.profile.downloaded_stories} saved files · ordered, timestamped, ID-matched
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
