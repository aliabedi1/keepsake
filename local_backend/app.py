from __future__ import annotations

import json
import hashlib
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib.parse import urlparse

import httpx
import zipstream
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from instagrapi import Client, config
from instagrapi.exceptions import (
    BadPassword,
    ChallengeRequired,
    ClientConnectionError,
    ClientThrottledError,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    TwoFactorRequired,
    UnknownError,
    UserNotFound,
)
from instagrapi.extractors import extract_highlight_v1, extract_media_v1
from pydantic import BaseModel, SecretStr


USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._]{1,30}$")
SESSION_TTL_SECONDS = 10 * 60
HIGHLIGHTS_PER_PAGE = 20
MOBILE_HIGHLIGHTS_BATCH_LIMIT = 100
HIGHLIGHTS_QUERY_ID = "9957820854288654"
LIBRARY_STALE_SECONDS = 24 * 60 * 60
DOWNLOAD_RETRIES = 5
MEDIA_CHUNK_SIZE = 256 * 1024
CONTINUE_HIGHLIGHT_DELAY_SECONDS = 8
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOWNLOAD_ROOT = PROJECT_ROOT / "downloads"


app = FastAPI(title="Keepsake Local API", version="5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Keepsake-Session"],
)


class LoginRequest(BaseModel):
    username: str
    password: SecretStr
    verification_code: str = ""


class ScanRequest(BaseModel):
    target_username: str
    mode: Literal["highlights", "posts"] = "highlights"


class StoriesRequest(ScanRequest):
    highlight_id: str


class HighlightsPageRequest(ScanRequest):
    page: int


class LibrarySyncRequest(ScanRequest):
    highlight_id: str | None = None
    undownloaded_only: bool = False


class PostsScanRequest(BaseModel):
    target_username: str


class PostsPageRequest(PostsScanRequest):
    page: int


class PostMediaRequest(PostsScanRequest):
    post_id: str


class PostsSyncRequest(PostsScanRequest):
    post_id: str | None = None
    undownloaded_only: bool = False


@dataclass
class BrowserSession:
    token: str
    username: str
    client: Client
    created_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    scans: dict[str, dict[str, Any]] = field(default_factory=dict)
    media: dict[str, dict[str, str]] = field(default_factory=dict)
    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)
    request_lock: threading.Lock = field(default_factory=threading.Lock)


browser_sessions: dict[str, BrowserSession] = {}
sessions_lock = threading.Lock()


def clean_username(value: str) -> str:
    username = value.strip().lstrip("@").lower()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(status_code=400, detail="Enter a valid Instagram username.")
    return username


def clean_target(value: str) -> str:
    target = value.strip()
    if target.startswith(("http://", "https://")):
        try:
            parsed = urlparse(target)
            if parsed.hostname not in {"instagram.com", "www.instagram.com"}:
                raise HTTPException(
                    status_code=400, detail="Enter an Instagram profile link."
                )
            parts = [part for part in parsed.path.split("/") if part]
            if not parts or parts[0] in {
                "stories",
                "explore",
                "reels",
                "p",
                "accounts",
            }:
                raise HTTPException(
                    status_code=400, detail="Enter a link to an Instagram profile."
                )
            target = parts[0]
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail="Enter a valid Instagram profile link."
            ) from exc
    return clean_username(target)


def safe_name(value: str, fallback: str, limit: int = 100) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", value).strip().rstrip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned[:limit] or fallback
    reserved = {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
    }
    if cleaned.split(".", 1)[0].upper() in reserved:
        cleaned = f"_{cleaned}"
    return cleaned


def string_url(value: Any) -> str:
    return "" if value is None else str(value)


def model_value(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(value, tz=timezone.utc)
    elif isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def media_taken_at(story: Any) -> tuple[str, str]:
    parsed = parse_utc(
        model_value(story, "taken_at")
        or model_value(story, "taken_at_timestamp")
        or model_value(story, "created_at")
    )
    if not parsed:
        return "", "unknown-time"
    return (
        parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        parsed.strftime("%Y%m%dT%H%M%SZ"),
    )


def is_stale(value: Any) -> bool:
    parsed = parse_utc(value)
    return not parsed or (datetime.now(timezone.utc) - parsed).total_seconds() > LIBRARY_STALE_SECONDS


def expire_inactive_sessions() -> None:
    now = time.time()
    with sessions_lock:
        expired = [
            token
            for token, session in browser_sessions.items()
            if now - session.last_seen > SESSION_TTL_SECONDS
        ]
        for token in expired:
            browser_sessions.pop(token, None)


def get_session(token: str | None, *, touch: bool = True) -> BrowserSession:
    expire_inactive_sessions()
    if not token:
        raise HTTPException(status_code=401, detail="Connect your Instagram account first.")
    with sessions_lock:
        session = browser_sessions.get(token)
        if session and touch:
            session.last_seen = time.time()
    if not session:
        raise HTTPException(
            status_code=401,
            detail="This browser session expired. Connect your Instagram account again.",
        )
    return session


def explain_instagram_error(exc: Exception, target: str = "") -> HTTPException:
    if isinstance(exc, UserNotFound):
        return HTTPException(status_code=404, detail=f"@{target} was not found.")
    if isinstance(exc, LoginRequired):
        return HTTPException(
            status_code=401,
            detail="Instagram ended this login session. Connect your account again.",
        )
    if isinstance(exc, (ClientThrottledError, PleaseWaitFewMinutes)):
        return HTTPException(
            status_code=429,
            detail=(
                "Instagram asked this account to slow down. Keepsake stopped immediately; "
                "wait before scanning again and do not repeatedly retry."
            ),
        )
    if isinstance(exc, FeedbackRequired):
        return HTTPException(
            status_code=403,
            detail=(
                "Instagram temporarily blocked this action. Open Instagram normally to "
                "review any account notice, then try later."
            ),
        )
    if isinstance(exc, ChallengeRequired):
        return HTTPException(
            status_code=403,
            detail=(
                "Instagram requires an account check. Complete it in the official "
                "Instagram app or website, then reconnect here."
            ),
        )
    if isinstance(exc, ClientConnectionError):
        return HTTPException(
            status_code=502,
            detail="Instagram could not complete the request. Check the connection and try once more.",
        )
    if isinstance(exc, UnknownError):
        if getattr(exc, "error_type", "") == "needs_upgrade":
            return HTTPException(
                status_code=502,
                detail=(
                    "Instagram rejected the login client as outdated. Restart Keepsake "
                    "using the start-local script to install the current dependencies. "
                    "If this continues, open Instagram normally and complete any account notice."
                ),
            )
        return HTTPException(
            status_code=502,
            detail=(
                "Instagram rejected the request without a recognized error reason. "
                "Open the official Instagram app or website, check that you can log in "
                "and complete any account notice, then reconnect here. "
                "If no notice appears, wait before trying again."
            ),
        )
    return HTTPException(
        status_code=502,
        detail=f"Instagram could not complete the request ({type(exc).__name__}).",
    )


def media_extension(story: Any, media_url: str) -> str:
    if model_value(story, "media_type", 1) == 2 or model_value(story, "video_url"):
        return ".mp4"
    suffix = Path(urlparse(media_url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def cover_url(highlight: Any) -> str:
    cover = model_value(highlight, "cover_media")
    cropped = model_value(cover, "cropped_image_version")
    gql_cropped = model_value(highlight, "cover_media_cropped_thumbnail")
    user = model_value(highlight, "user")
    for candidate in (
        model_value(cropped, "url"),
        model_value(gql_cropped, "url"),
        model_value(cover, "thumbnail_url"),
        model_value(user, "profile_pic_url"),
    ):
        if candidate:
            return string_url(candidate)
    return ""


def largest_media_url(versions: Any) -> str:
    if not isinstance(versions, list):
        return ""
    candidates = [item for item in versions if isinstance(item, dict) and item.get("url")]
    if not candidates:
        return ""
    largest = max(
        candidates,
        key=lambda item: (item.get("width") or 0) * (item.get("height") or 0),
    )
    return string_url(largest["url"])


def media_source_url(story: Any, is_video: bool) -> str:
    direct_url = model_value(story, "video_url" if is_video else "thumbnail_url")
    if direct_url:
        return string_url(direct_url)
    if is_video:
        return largest_media_url(model_value(story, "video_versions"))
    image_versions = model_value(story, "image_versions2", {})
    return largest_media_url(model_value(image_versions, "candidates", []))


def normalize_media_files(items: list[Any]) -> list[dict[str, Any]]:
    stories: list[dict[str, Any]] = []
    for story_index, story in enumerate(items, start=1):
        is_video = bool(
            model_value(story, "media_type", 1) == 2
            or model_value(story, "video_url")
        )
        media_url = media_source_url(story, is_video)
        if not media_url:
            continue
        extension = media_extension(story, media_url)
        story_id = str(model_value(story, "pk", story_index))
        taken_at, timestamp_name = media_taken_at(story)
        stories.append(
            {
                "id": story_id,
                "position": story_index,
                "type": "video" if is_video else "image",
                "taken_at": taken_at,
                "filename": (
                    f"{story_index:04d}__{timestamp_name}__ig_{story_id}{extension}"
                ),
                "media_url": media_url,
            }
        )
    return stories


def normalize_stories(highlight: Any) -> list[dict[str, Any]]:
    return normalize_media_files(model_value(highlight, "items", []) or [])


def normalize_scan(profile: Any, highlights: list[Any]) -> dict[str, Any]:
    normalized_highlights: list[dict[str, Any]] = []
    used_folders: set[str] = set()

    for highlight_index, highlight in enumerate(highlights):
        title = (
            model_value(highlight, "title", "")
            or f"Highlight {highlight_index + 1}"
        )
        base_folder = safe_name(title, f"Highlight {highlight_index + 1}")
        folder = base_folder
        duplicate_index = 2
        while folder.casefold() in used_folders:
            folder = safe_name(f"{base_folder} ({duplicate_index})", base_folder)
            duplicate_index += 1
        used_folders.add(folder.casefold())

        stories = normalize_stories(highlight)
        reported_count = int(model_value(highlight, "media_count", len(stories)) or 0)

        normalized_highlights.append(
            {
                "id": str(
                    model_value(highlight, "pk")
                    or model_value(highlight, "id")
                    or highlight_index
                ).removeprefix("highlight:"),
                "title": title,
                "kind": "highlights",
                "folder_name": folder,
                "cover_url": cover_url(highlight),
                "item_count": max(reported_count, len(stories)),
                "position": highlight_index,
                "stories": stories,
                "media_loaded": bool(stories) or reported_count == 0,
            }
        )

    return {
        "profile": {
            "id": str(getattr(profile, "pk", "")),
            "username": str(getattr(profile, "username", "")),
            "full_name": str(getattr(profile, "full_name", "") or ""),
            "profile_pic_url": string_url(
                getattr(profile, "profile_pic_url_hd", None)
                or getattr(profile, "profile_pic_url", None)
            ),
            "is_private": bool(getattr(profile, "is_private", False)),
        },
        "highlights": normalized_highlights,
    }


def scan_key(target: str, mode: str) -> str:
    return f"posts:{target}" if mode == "posts" else target



def scan_collections(scan: dict[str, Any]) -> list[dict[str, Any]]:
    return scan["posts" if scan.get("mode") == "posts" else "highlights"]


def collection_media(collection: dict[str, Any]) -> list[dict[str, Any]]:
    return collection.get("files" if collection.get("kind") == "posts" else "stories") or []


def manifest_media(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    # Read post manifests written before the separate post-file definition.
    return manifest.get("files", manifest.get("stories", [])) or []


def normalize_post(media: Any, position: int) -> dict[str, Any]:
    post_id = str(model_value(media, "pk"))
    taken_at, timestamp = media_taken_at(media)
    resources = model_value(media, "resources", []) or [media]
    items = []
    for resource in resources:
        items.append({
            "pk": model_value(resource, "pk"),
            "media_type": model_value(resource, "media_type", 1),
            "video_url": model_value(resource, "video_url"),
            "thumbnail_url": model_value(resource, "thumbnail_url"),
            "taken_at": taken_at,
        })
    files = normalize_media_files(items)
    return {
        "id": post_id,
        "kind": "posts",
        "title": f"Post {timestamp}",
        "caption": str(model_value(media, "caption_text", "") or ""),
        "taken_at": taken_at,
        "folder_name": f"Post {post_id}",
        "cover_url": string_url(model_value(media, "thumbnail_url") or model_value(resources[0], "thumbnail_url")),
        "item_count": len(resources),
        "position": position,
        "files": files,
        "media_loaded": len(files) == len(resources),
    }


def fetch_posts_page(session: BrowserSession, scan: dict[str, Any]) -> None:
    # Read the whole returned batch: truncating it can skip posts before the cursor.
    with session.request_lock:
        cursor = scan.get("next_cursor", "")
        payload = session.client.private_request(
            f"feed/user/{scan['profile']['id']}/",
            params={
                "max_id": cursor,
                "count": HIGHLIGHTS_PER_PAGE,
                "rank_token": session.client.rank_token,
                "ranked_content": "true",
            },
        )
        if not isinstance(payload.get("items"), list):
            raise HTTPException(status_code=502, detail="Instagram returned an incomplete posts page. Try again later.")
        next_cursor = str(payload.get("next_max_id") or "")
        if next_cursor and next_cursor in scan.get("seen_cursors", []):
            raise HTTPException(status_code=502, detail="Instagram repeated a posts page. Try again later.")
        existing = {item["id"] for item in scan_collections(scan)}
        posts = []
        for raw in payload["items"]:
            post = normalize_post(extract_media_v1(raw), len(scan_collections(scan)) + len(posts))
            post["item_count"] = max(post["item_count"], int(raw.get("carousel_media_count", 0) or 0))
            post["media_loaded"] = len(post["files"]) == post["item_count"]
            if post["id"] in existing:
                continue
            existing.add(post["id"])
            # Register preview URLs only when a page is shown, so a full feed
            # sync cannot evict visible covers from the bounded media registry.
            post["cover_source_url"] = post["cover_url"]
            post["cover_url"] = ""
            posts.append(post)
        scan_collections(scan).extend(posts)
        scan["next_cursor"] = next_cursor
        scan["has_more"] = bool(next_cursor)
        loaded_posts = len(scan_collections(scan))
        # Profile metadata supplies the total before all cursor pages are fetched.
        # Once the feed ends, the deduplicated result is authoritative.
        scan["total_posts"] = (
            max(int(scan.get("total_posts", 0)), loaded_posts)
            if next_cursor else loaded_posts
        )
        if next_cursor:
            scan.setdefault("seen_cursors", []).append(next_cursor)


def fetch_profile_scan(session: BrowserSession, target: str, mode: str) -> dict[str, Any]:
    with session.request_lock:
        profile = session.client.user_info_by_username_v1(target)
        highlights = all_user_highlights(session.client, str(profile.pk)) if mode == "highlights" else []
    scan = normalize_scan(profile, highlights)
    if mode == "posts":
        scan["posts"] = scan.pop("highlights")
        scan["total_posts"] = max(int(model_value(profile, "media_count", 0) or 0), 0)
    scan["mode"] = mode
    if mode == "posts":
        fetch_posts_page(session, scan)
        # Without a usable profile count, finish indexing rather than inventing
        # a total from the loaded batch and revealing one extra page at a time.
        if not model_value(profile, "media_count", 0):
            while scan.get("has_more"):
                time.sleep(2)
                fetch_posts_page(session, scan)
    else:
        for highlight in scan_collections(scan):
            highlight["cover_url"] = proxy_media_url(session, highlight["cover_url"], f"highlight-{highlight['id']}-cover.jpg")
    scan["profile"]["profile_pic_url"] = proxy_media_url(
        session, scan["profile"]["profile_pic_url"], f"{target}-profile.jpg",
    )
    attach_library_state(scan)
    return scan


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def account_folder_name(profile: dict[str, Any]) -> str:
    username = safe_name(profile.get("username", ""), "instagram", 30)
    user_id = safe_name(str(profile.get("id", "")), "unknown", 40)
    return f"{username}__ig_{user_id}"


def find_account_directory(user_id: str) -> Path | None:
    if not DOWNLOAD_ROOT.exists():
        return None
    for directory in DOWNLOAD_ROOT.iterdir():
        if not directory.is_dir():
            continue
        manifest = read_json(directory / "account.json")
        if str((manifest.get("profile") or {}).get("id", "")) == str(user_id):
            return directory
    return None


def account_directory(profile: dict[str, Any], *, create: bool = False) -> Path:
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    existing = find_account_directory(str(profile.get("id", "")))
    desired = DOWNLOAD_ROOT / account_folder_name(profile)
    if existing and create and existing != desired and not desired.exists():
        existing.rename(desired)
        existing = desired
    directory = existing or desired
    if create:
        (directory / "highlights").mkdir(parents=True, exist_ok=True)
    return directory


def collection_folder_name(highlight: dict[str, Any]) -> str:
    title = safe_name(
        str(highlight.get("title", "")),
        f"Highlight {int(highlight.get('position', 0)) + 1}",
        24,
    )
    return (
        f"{int(highlight.get('position', 0)) + 1:03d}__{title}"
        f"__ig_{safe_name(str(highlight.get('id', '')), 'unknown', 50)}"
    )


def find_collection_directory(account_dir: Path, highlight_id: str, mode: str = "highlights") -> Path | None:
    parent = account_dir / mode
    if not parent.exists():
        return None
    for directory in parent.iterdir():
        if not directory.is_dir():
            continue
        manifest = read_json(directory / "manifest.json")
        if str(manifest.get("id", "")) == str(highlight_id):
            return directory
    return None


def collection_directory(
    account_dir: Path, highlight: dict[str, Any], *, create: bool = False
) -> Path:
    mode = highlight.get("kind", "highlights")
    parent = account_dir / mode
    existing = find_collection_directory(account_dir, str(highlight["id"]), mode)
    desired = parent / collection_folder_name(highlight)
    if existing and create and existing != desired and not desired.exists():
        existing.rename(desired)
        existing = desired
    directory = existing or desired
    if create:
        for child in ("current", "removed", "corrupt"):
            (directory / child).mkdir(parents=True, exist_ok=True)
    return directory


def media_signature_is_valid(path: Path) -> bool:
    try:
        if path.stat().st_size <= 0:
            return False
        with path.open("rb") as source:
            header = source.read(16)
    except OSError:
        return False
    return bool(
        header.startswith(b"\xff\xd8\xff")
        or header.startswith(b"\x89PNG\r\n\x1a\n")
        or (header.startswith(b"RIFF") and header[8:12] == b"WEBP")
        or (len(header) >= 12 and header[4:8] == b"ftyp")
    )


def local_record_path(highlight_dir: Path, record: dict[str, Any]) -> Path | None:
    relative = str(record.get("local_path", ""))
    if not relative:
        return None
    candidate = (highlight_dir / relative).resolve()
    try:
        candidate.relative_to(highlight_dir.resolve())
    except ValueError:
        return None
    return candidate


def record_file_is_valid(highlight_dir: Path, record: dict[str, Any]) -> bool:
    path = local_record_path(highlight_dir, record)
    if not path or not path.is_file() or not media_signature_is_valid(path):
        return False
    expected_size = int(record.get("size", 0) or 0)
    return not expected_size or path.stat().st_size == expected_size


def candidate_file_is_valid(path: Path, record: dict[str, Any] | None) -> bool:
    if not path.is_file() or not media_signature_is_valid(path):
        return False
    expected_size = int((record or {}).get("size", 0) or 0)
    if expected_size and path.stat().st_size != expected_size:
        return False
    expected_checksum = str((record or {}).get("sha256", ""))
    return not expected_checksum or sha256_file(path) == expected_checksum


def collection_library_state(
    account_dir: Path, highlight: dict[str, Any]
) -> dict[str, Any]:
    directory = find_collection_directory(account_dir, str(highlight["id"]), highlight.get("kind", "highlights"))
    manifest = read_json(directory / "manifest.json") if directory else {}
    records = manifest_media(manifest)
    current_records = [
        record for record in records
        if isinstance(record, dict) and not record.get("removed_from_instagram")
    ]
    removed_records = [
        record for record in records
        if isinstance(record, dict) and record.get("removed_from_instagram")
    ]
    downloaded = sum(
        record_file_is_valid(directory, record) for record in current_records
    ) if directory else 0
    removed = sum(
        record_file_is_valid(directory, record) for record in removed_records
    ) if directory else 0
    failed = sum(bool(record.get("error")) for record in current_records)
    checked_at = manifest.get("last_checked_at", "")
    old = bool(downloaded or removed) and is_stale(checked_at)
    remote_count = int(highlight.get("item_count", 0) or 0)
    if not downloaded and not removed:
        status = "not_downloaded"
    elif downloaded < remote_count:
        status = "partial"
    elif old:
        status = "old"
    else:
        status = "current"
    return {
        "local_status": status,
        "downloaded_count": downloaded,
        "removed_count": removed,
        "failed_count": failed,
        "last_updated_at": checked_at,
        "is_old": old,
        "has_local": bool(downloaded or removed),
    }


def attach_library_state(scan: dict[str, Any]) -> None:
    account_dir = account_directory(scan["profile"])
    saved_total = 0
    undownloaded_total = 0
    old_highlights = 0
    latest_update = ""
    for highlight in scan_collections(scan):
        state = collection_library_state(account_dir, highlight)
        highlight.update(state)
        saved_total += state["downloaded_count"] + state["removed_count"]
        undownloaded_total += max(
            int(highlight.get("item_count", 0) or 0) - state["downloaded_count"],
            0,
        )
        old_highlights += int(state["is_old"])
        latest_update = max(latest_update, str(state["last_updated_at"]))
    remote_ids = {str(highlight["id"]) for highlight in scan_collections(scan)}
    highlights_root = account_dir / scan.get("mode", "highlights")
    for directory in highlights_root.iterdir() if highlights_root.exists() else []:
        if not directory.is_dir():
            continue
        manifest = read_json(directory / "manifest.json")
        if str(manifest.get("id", "")) in remote_ids:
            continue
        saved_total += sum(
            record_file_is_valid(directory, record)
            for record in manifest_media(manifest)
            if isinstance(record, dict)
        )
    scan["profile"].update(
        {
            "downloaded_files" if scan.get("mode") == "posts" else "downloaded_stories": saved_total,
            "undownloaded_files" if scan.get("mode") == "posts" else "undownloaded_stories": undownloaded_total,
            "has_local": saved_total > 0,
            "is_old": old_highlights > 0,
            "old_posts" if scan.get("mode") == "posts" else "old_highlights": old_highlights,
            "last_updated_at": latest_update,
        }
    )


def highlight_identity(highlight: Any) -> str:
    return str(
        model_value(highlight, "pk")
        or model_value(highlight, "id")
        or ""
    ).removeprefix("highlight:")


def extend_unique_highlights(
    highlights: list[Any], page: list[Any], seen_ids: set[str]
) -> None:
    for highlight in page:
        highlight_id = highlight_identity(highlight)
        if not highlight_id or highlight_id in seen_ids:
            continue
        seen_ids.add(highlight_id)
        highlights.append(highlight)


def mobile_highlights_page(
    client: Client, user_id: str, cursor: str | None = None
) -> dict[str, Any]:
    params = {
        "supported_capabilities_new": json.dumps(config.SUPPORTED_CAPABILITIES),
        "phone_id": client.phone_id,
        "battery_level": 100,
        "panavision_mode": "",
        "is_charging": 1,
        "is_dark_mode": 0,
        "will_sound_on": 0,
    }
    if cursor:
        params["cursor"] = cursor
    return client.private_request(
        f"highlights/{int(user_id)}/highlights_tray/", params=params
    )


def mobile_highlights_cursor(payload: dict[str, Any]) -> str:
    pagination = payload.get("pagination") or {}
    return str(
        payload.get("cursor")
        or payload.get("next_max_id")
        or payload.get("max_id")
        or pagination.get("next_max_id")
        or pagination.get("end_cursor")
        or ""
    )


def find_highlights_connection(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    for key, child in value.items():
        if (
            "highlight" in key.casefold()
            and isinstance(child, dict)
            and isinstance(child.get("page_info"), dict)
            and isinstance(child.get("edges") or child.get("nodes"), list)
        ):
            return child
    for child in value.values():
        connection = find_highlights_connection(child)
        if connection:
            return connection
    return None


def graphql_highlights_page(
    client: Client, user_id: str, after: str | None = None
) -> dict[str, Any] | None:
    variables: dict[str, Any] = {
        "user_id": user_id,
        "first": 50,
        "include_chaining": False,
        "include_reel": True,
        "include_suggested_users": False,
        "include_logged_out_extras": True,
        "include_live_status": False,
        "include_highlight_reels": True,
    }
    if after:
        variables["after"] = after
    client.inject_sessionid_to_public()
    data = client.public_graphql_request(variables, query_id=HIGHLIGHTS_QUERY_ID)
    return find_highlights_connection(data)


def all_user_highlights(client: Client, user_id: str) -> list[Any]:
    highlights: list[Any] = []
    seen_ids: set[str] = set()
    seen_cursors: set[str] = set()
    cursor: str | None = None
    used_mobile_pagination = False

    while True:
        payload = mobile_highlights_page(client, user_id, cursor)
        tray = payload.get("tray") or []
        next_cursor = mobile_highlights_cursor(payload)
        extend_unique_highlights(
            highlights,
            [extract_highlight_v1(item) for item in tray],
            seen_ids,
        )
        if (
            payload.get("has_fetched_all_remaining_highlights") is True
            or not next_cursor
            or next_cursor in seen_cursors
        ):
            break
        used_mobile_pagination = True
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    # Some older mobile responses stop at 100 items without a usable cursor.
    # Keep the profile connection as a best-effort fallback for that shape.
    if len(highlights) < MOBILE_HIGHLIGHTS_BATCH_LIMIT or used_mobile_pagination:
        return highlights

    graphql_highlights: list[Any] = []
    graphql_ids: set[str] = set()
    seen_cursors.clear()
    after: str | None = None
    while True:
        connection = graphql_highlights_page(client, user_id, after)
        if not connection:
            break
        edges = connection.get("edges") or connection.get("nodes") or []
        nodes = [
            edge.get("node", edge) if isinstance(edge, dict) else edge
            for edge in edges
        ]
        extend_unique_highlights(graphql_highlights, nodes, graphql_ids)
        page_info = connection.get("page_info") or {}
        next_after = str(page_info.get("end_cursor") or "")
        if (
            not page_info.get("has_next_page")
            or not next_after
            or next_after in seen_cursors
        ):
            break
        seen_cursors.add(next_after)
        after = next_after

    return graphql_highlights if len(graphql_highlights) > len(highlights) else highlights


def public_scan_payload(
    scan: dict[str, Any], page: int = 1, session: BrowserSession | None = None,
) -> dict[str, Any]:
    loaded_collections = len(scan_collections(scan))
    total_collections = (
        int(scan.get("total_posts", loaded_collections))
        if scan.get("mode") == "posts" else loaded_collections
    )
    total_pages = (
        (total_collections + HIGHLIGHTS_PER_PAGE - 1) // HIGHLIGHTS_PER_PAGE
        if total_collections
        else 0
    )
    if (
        page < 1
        or (not total_pages and page != 1)
        or (total_pages and page > total_pages)
    ):
        raise HTTPException(status_code=404, detail=f"That {scan.get('mode', 'highlights')} page does not exist.")

    first_highlight = (page - 1) * HIGHLIGHTS_PER_PAGE
    page_highlights = scan_collections(scan)[
        first_highlight : first_highlight + HIGHLIGHTS_PER_PAGE
    ]
    if session and scan.get("mode") == "posts":
        for post in page_highlights:
            post["cover_url"] = proxy_media_url(
                session, post.get("cover_source_url", ""), f"post-{post['id']}-cover.jpg",
            )
    return {
        "mode": scan.get("mode", "highlights"),
        "has_more": bool(scan.get("has_more")),
        "profile": dict(scan["profile"]),
        "page": page,
        "page_size": HIGHLIGHTS_PER_PAGE,
        "total_pages": total_pages,
        "total_posts" if scan.get("mode") == "posts" else "total_highlights": total_collections,
        "total_files" if scan.get("mode") == "posts" else "total_stories": sum(
            highlight["item_count"] for highlight in scan_collections(scan)
        ),
        "posts" if scan.get("mode") == "posts" else "highlights": [
            {
                key: value
                for key, value in highlight.items()
                if key not in {"stories", "files", "folder_name", "media_loaded", "cover_source_url"}
            }
            for highlight in page_highlights
        ],
    }


def raw_highlight_detail(client: Client, highlight_id: str) -> dict[str, Any]:
    reel_id = f"highlight:{highlight_id}"
    result = client.private_request(
        "feed/reels_media/",
        {
            "exclude_media_ids": "[]",
            "supported_capabilities_new": json.dumps(config.SUPPORTED_CAPABILITIES),
            "source": "profile",
            "_uid": str(client.user_id),
            "_uuid": client.uuid,
            "user_ids": [reel_id],
        },
    )
    reels = result.get("reels", {})
    if isinstance(reels, dict):
        detail = reels.get(reel_id)
    else:
        detail = next(
            (
                reel
                for reel in reels or []
                if model_value(reel, "id") == reel_id
                or str(model_value(reel, "pk", "")) == highlight_id
            ),
            None,
        )
    if not isinstance(detail, dict):
        raise HTTPException(status_code=404, detail="That highlight is no longer available.")
    return detail


def hydrate_collection(session: BrowserSession, highlight: dict[str, Any]) -> None:
    if highlight["media_loaded"]:
        return

    try:
        if highlight.get("kind") == "posts":
            with session.request_lock:
                payload = session.client.private_request(f"media/{highlight['id']}/info/")
            items = payload.get("items") or []
            if not items:
                raise HTTPException(status_code=404, detail="That post is no longer available.")
            media = extract_media_v1(items[0])
            refreshed = normalize_post(media, highlight["position"])
            expected_count = int(items[0].get("carousel_media_count", refreshed["item_count"]) or refreshed["item_count"])
            if refreshed["item_count"] < expected_count:
                raise HTTPException(status_code=502, detail="Instagram returned an incomplete carousel. Try again later.")
            highlight.update({key: refreshed[key] for key in ("files", "item_count", "media_loaded", "caption", "taken_at")})
            if not highlight["media_loaded"]:
                raise HTTPException(status_code=502, detail="Instagram did not return all media for this post. Try again later.")
            return
        with session.request_lock:
            if highlight["media_loaded"]:
                return
            detail = raw_highlight_detail(session.client, highlight["id"])
            stories = normalize_stories(detail)
            highlight["stories"] = stories
            highlight["item_count"] = len(stories)
            highlight["media_loaded"] = True
            detailed_cover = cover_url(detail)
            if detailed_cover and not highlight["cover_url"]:
                highlight["cover_url"] = proxy_media_url(
                    session,
                    detailed_cover,
                    f"highlight-{highlight['id']}-cover.jpg",
                )
    except HTTPException:
        raise
    except Exception as exc:
        raise explain_instagram_error(exc) from exc


def register_media(session: BrowserSession, media_url: str, filename: str) -> str:
    token = uuid.uuid4().hex
    session.media[token] = {
        "url": media_url,
        "filename": filename,
    }
    if len(session.media) > 2000:
        for stale_token in list(session.media)[:500]:
            session.media.pop(stale_token, None)
    return token


def proxy_media_url(session: BrowserSession, media_url: str, filename: str) -> str:
    if not media_url:
        return ""
    token = register_media(session, media_url, filename)
    return f"http://127.0.0.1:8787/api/media/{token}"


def media_chunks(session: BrowserSession, media_url: str) -> Iterator[bytes]:
    headers = {
        "Accept": "*/*",
        "Referer": "https://www.instagram.com/",
        "User-Agent": getattr(session.client, "user_agent", None) or "Mozilla/5.0",
    }
    timeout = httpx.Timeout(60, connect=15)
    with httpx.stream(
        "GET",
        media_url,
        headers=headers,
        follow_redirects=True,
        timeout=timeout,
    ) as response:
        response.raise_for_status()
        for chunk in response.iter_bytes(chunk_size=MEDIA_CHUNK_SIZE):
            if chunk:
                yield chunk


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(MEDIA_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def quarantine_file(highlight_dir: Path, path: Path) -> None:
    if not path.exists():
        return
    destination = highlight_dir / "corrupt" / f"{path.stem}__{uuid.uuid4().hex[:8]}{path.suffix}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    path.replace(destination)


def find_media_candidate(
    highlight_dir: Path, story_id: str, old_record: dict[str, Any] | None
) -> Path | None:
    if old_record:
        recorded = local_record_path(highlight_dir, old_record)
        if recorded and recorded.is_file():
            return recorded
    pattern = f"*__ig_{story_id}.*"
    for child in ("current", "removed"):
        for candidate in (highlight_dir / child).glob(pattern):
            if candidate.is_file() and not candidate.name.startswith("."):
                return candidate
    return None


def download_media_file(
    session: BrowserSession, media_url: str, destination: Path
) -> tuple[int, str]:
    partial = destination.with_name(f".{destination.name}.part")
    headers = {
        "Accept": "*/*",
        "Referer": "https://www.instagram.com/",
        "User-Agent": getattr(session.client, "user_agent", None) or "Mozilla/5.0",
    }
    timeout = httpx.Timeout(120, connect=20)
    last_error: Exception | None = None
    destination.parent.mkdir(parents=True, exist_ok=True)

    for attempt in range(DOWNLOAD_RETRIES):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            request_headers = dict(headers)
            if offset:
                request_headers["Range"] = f"bytes={offset}-"
            with httpx.stream(
                "GET",
                media_url,
                headers=request_headers,
                follow_redirects=True,
                timeout=timeout,
            ) as response:
                if response.status_code == 416 and offset:
                    content_range = response.headers.get("Content-Range", "")
                    range_total = content_range.rsplit("/", 1)[-1]
                    remote_size = (
                        int(range_total)
                        if "/" in content_range and range_total.isdigit()
                        else 0
                    )
                    if remote_size == offset and media_signature_is_valid(partial):
                        partial.replace(destination)
                        return destination.stat().st_size, sha256_file(destination)
                    partial.unlink(missing_ok=True)
                response.raise_for_status()
                content_range = response.headers.get("Content-Range", "")
                append = (
                    offset > 0
                    and response.status_code == 206
                    and content_range.startswith(f"bytes {offset}-")
                )
                if offset and response.status_code == 206 and not append:
                    partial.unlink(missing_ok=True)
                    raise ValueError("Instagram returned an unexpected resume range.")
                mode = "ab" if append else "wb"
                with partial.open(mode) as output:
                    for chunk in response.iter_bytes(chunk_size=MEDIA_CHUNK_SIZE):
                        if chunk:
                            output.write(chunk)
                expected_size = 0
                if response.status_code == 206 and "/" in content_range:
                    total = content_range.rsplit("/", 1)[-1]
                    expected_size = int(total) if total.isdigit() else 0
                elif response.headers.get("Content-Length", "").isdigit():
                    expected_size = int(response.headers["Content-Length"])
                if expected_size and partial.stat().st_size != expected_size:
                    raise ValueError(
                        f"Instagram sent {partial.stat().st_size} of {expected_size} bytes."
                    )
            if not media_signature_is_valid(partial):
                partial.unlink(missing_ok=True)
                raise ValueError("Instagram returned an invalid or incomplete media file.")
            if destination.exists():
                destination.unlink()
            partial.replace(destination)
            return destination.stat().st_size, sha256_file(destination)
        except Exception as exc:
            last_error = exc
            if attempt + 1 < DOWNLOAD_RETRIES:
                time.sleep(min(2 ** attempt, 8))

    raise RuntimeError(
        f"Media download failed after {DOWNLOAD_RETRIES} attempts: {last_error}"
    )


def save_collection_manifest(
    path: Path,
    highlight: dict[str, Any],
    stories: list[dict[str, Any]],
    checked_at: str,
) -> None:
    write_json(
        path,
        {
            "version": 1,
            "id": highlight["id"],
            "title": highlight["title"],
            "position": highlight["position"],
            "kind": highlight.get("kind", "highlights"),
            "caption": highlight.get("caption", ""),
            "taken_at": highlight.get("taken_at", ""),
            "last_checked_at": checked_at,
            "remote_file_count" if highlight.get("kind") == "posts" else "remote_story_count": len(collection_media(highlight)),
            "files" if highlight.get("kind") == "posts" else "stories": stories,
        },
    )


def reconcile_collection(
    session: BrowserSession,
    account_dir: Path,
    highlight: dict[str, Any],
    job: dict[str, Any],
) -> None:
    directory = collection_directory(account_dir, highlight, create=True)
    manifest_path = directory / "manifest.json"
    previous = read_json(manifest_path)
    old_records = {
        str(record.get("id", "")): record
        for record in manifest_media(previous)
        if isinstance(record, dict) and record.get("id")
    }
    remote_ids = {str(story["id"]) for story in collection_media(highlight)}
    checked_at = utc_now()
    reconciled: list[dict[str, Any]] = []

    for old_id, old_record in old_records.items():
        if old_id in remote_ids:
            continue
        candidate = find_media_candidate(directory, old_id, old_record)
        if candidate and candidate_file_is_valid(candidate, old_record):
            destination = directory / "removed" / candidate.name
            if candidate != destination:
                if destination.exists():
                    destination = destination.with_name(
                        f"{destination.stem}__{uuid.uuid4().hex[:8]}{destination.suffix}"
                    )
                candidate.replace(destination)
            removed_record = dict(old_record)
            removed_record.update(
                {
                    "local_path": destination.relative_to(directory).as_posix(),
                    "removed_from_instagram": True,
                    "removed_at": checked_at,
                    "error": "",
                }
            )
            reconciled.append(removed_record)

    for story in collection_media(highlight):
        story_id = str(story["id"])
        old_record = old_records.get(story_id)
        destination = directory / "current" / story["filename"]
        candidate = find_media_candidate(directory, story_id, old_record)
        record = {
            "id": story_id,
            "position": story["position"],
            "taken_at": story["taken_at"],
            "type": story["type"],
            "filename": story["filename"],
            "local_path": f"current/{story['filename']}",
            "removed_from_instagram": False,
            "downloaded_at": (old_record or {}).get("downloaded_at", ""),
            "size": int((old_record or {}).get("size", 0) or 0),
            "sha256": (old_record or {}).get("sha256", ""),
            "error": "",
        }
        job["current_file"] = story["position"]
        job["current_file_total"] = len(collection_media(highlight))

        if candidate and candidate_file_is_valid(candidate, old_record):
            if candidate != destination:
                if destination.exists() and not media_signature_is_valid(destination):
                    quarantine_file(directory, destination)
                candidate.replace(destination)
            record["size"] = destination.stat().st_size
            record["sha256"] = record["sha256"] or sha256_file(destination)
            record["downloaded_at"] = record["downloaded_at"] or checked_at
            job["reused_items"] += 1
        elif destination.exists() and media_signature_is_valid(destination):
            record["size"] = destination.stat().st_size
            record["sha256"] = sha256_file(destination)
            record["downloaded_at"] = record["downloaded_at"] or checked_at
            job["reused_items"] += 1
        else:
            if candidate and candidate.exists():
                quarantine_file(directory, candidate)
            if destination.exists():
                quarantine_file(directory, destination)
            try:
                size, checksum = download_media_file(
                    session, story["media_url"], destination
                )
                record.update(
                    {
                        "size": size,
                        "sha256": checksum,
                        "downloaded_at": checked_at,
                    }
                )
                job["downloaded_items"] += 1
            except Exception as exc:
                record["error"] = str(exc)
                job["failed_items"] += 1
                job["errors"].append(
                    f"{highlight['title']} {'file' if highlight.get('kind') == 'posts' else 'story'} {story['position']}: {exc}"
                )
        reconciled.append(record)
        job["processed_items"] += 1
        save_collection_manifest(manifest_path, highlight, reconciled, checked_at)

    save_collection_manifest(manifest_path, highlight, reconciled, checked_at)


def save_account_manifest(
    account_dir: Path, scan: dict[str, Any], *, full_sync: bool
) -> None:
    path = account_dir / "account.json"
    previous = read_json(path)
    mode = scan.get("mode", "highlights")
    previous_highlights = {
        str(item.get("id", "")): item
        for item in previous.get(mode) or []
        if isinstance(item, dict) and item.get("id")
    }
    current_ids: set[str] = set()
    highlights: list[dict[str, Any]] = []
    for highlight in scan_collections(scan):
        highlight_id = str(highlight["id"])
        current_ids.add(highlight_id)
        directory = find_collection_directory(account_dir, highlight_id, mode)
        highlights.append(
            {
                "id": highlight_id,
                "title": highlight["title"],
                "position": highlight["position"],
                "directory": directory.name if directory else "",
                "available_on_instagram": True,
            }
        )
    for highlight_id, item in previous_highlights.items():
        if highlight_id not in current_ids:
            removed = dict(item)
            if full_sync:
                removed["available_on_instagram"] = False
                removed["removed_at"] = utc_now()
            highlights.append(removed)
    write_json(
        path,
        {
            **previous,
            "version": 1,
            "profile": dict(scan["profile"]),
            "last_checked_at": utc_now() if full_sync else previous.get("last_checked_at", ""),
            mode: highlights,
        },
    )


@app.get("/api/status")
def status(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    expire_inactive_sessions()
    if not session_token:
        return {"api_version": 5, "supported_modes": ["highlights", "posts"], "ready": True, "connected": False, "username": None}
    try:
        session = get_session(session_token)
    except HTTPException:
        return {"api_version": 5, "supported_modes": ["highlights", "posts"], "ready": True, "connected": False, "username": None}
    return {"api_version": 5, "supported_modes": ["highlights", "posts"], "ready": True, "connected": True, "username": session.username}


@app.post("/api/session/login")
def login(request: LoginRequest) -> dict[str, Any]:
    username = clean_username(request.username)
    password = request.password.get_secret_value()
    verification_code = re.sub(r"\s+", "", request.verification_code)
    if not password:
        raise HTTPException(status_code=400, detail="Enter your Instagram password.")
    if verification_code and not re.fullmatch(r"\d{6}|\d{8}", verification_code):
        raise HTTPException(
            status_code=400, detail="Enter the 6-digit code or an 8-digit backup code."
        )

    client = Client()
    client.delay_range = [1, 3]
    try:
        logged_in = client.login(username, password, verification_code=verification_code)
    except TwoFactorRequired as exc:
        raise HTTPException(
            status_code=409,
            detail="Two-factor authentication is enabled. Enter the current code and connect again.",
        ) from exc
    except BadPassword as exc:
        raise HTTPException(
            status_code=401,
            detail="Instagram rejected that username or password.",
        ) from exc
    except Exception as exc:
        raise explain_instagram_error(exc) from exc

    if not logged_in or not client.user_id:
        client.password = ""
        raise HTTPException(
            status_code=502,
            detail=(
                "Instagram did not establish an authenticated session. "
                "Open Instagram normally and complete any account notice before reconnecting."
            ),
        )

    # The authenticated client keeps cookies/device settings in memory. The password
    # is deliberately discarded and is never written to disk.
    client.password = ""
    token = uuid.uuid4().hex
    session = BrowserSession(token=token, username=username, client=client)
    with sessions_lock:
        browser_sessions[token] = session
    return {
        "connected": True,
        "username": username,
        "session_token": token,
        "expires_without_heartbeat_seconds": SESSION_TTL_SECONDS,
    }


@app.post("/api/session/heartbeat")
def heartbeat(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, bool]:
    get_session(session_token)
    return {"connected": True}


@app.delete("/api/session")
def logout(
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, bool]:
    if session_token:
        with sessions_lock:
            browser_sessions.pop(session_token, None)
    return {"connected": False}


@app.post("/api/highlights/scan")
def scan_profile(
    request: ScanRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    try:
        scan = fetch_profile_scan(session, target, request.mode)
    except HTTPException:
        raise
    except Exception as exc:
        raise explain_instagram_error(exc, target) from exc
    session.scans[scan_key(target, request.mode)] = scan
    return public_scan_payload(scan, session=session)


@app.post("/api/highlights/page")
def scan_profile_page(
    request: HighlightsPageRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    scan = session.scans.get(scan_key(target, request.mode))
    if not scan:
        raise HTTPException(status_code=409, detail="Scan this profile again first.")
    page = request.page
    if request.mode == "posts":
        total_posts = int(scan.get("total_posts", len(scan_collections(scan))))
        total_pages = max(1, (total_posts + HIGHLIGHTS_PER_PAGE - 1) // HIGHLIGHTS_PER_PAGE)
        if page < 1 or page > total_pages:
            raise HTTPException(status_code=404, detail="That posts page does not exist.")
        try:
            while scan.get("has_more") and len(scan_collections(scan)) < page * HIGHLIGHTS_PER_PAGE:
                fetch_posts_page(session, scan)
            if not scan.get("has_more"):
                # If profile metadata overcounted the feed, show its actual last
                # page instead of failing the previously valid navigation.
                actual_pages = max(1, (len(scan_collections(scan)) + HIGHLIGHTS_PER_PAGE - 1) // HIGHLIGHTS_PER_PAGE)
                page = min(page, actual_pages)
        except HTTPException:
            raise
        except Exception as exc:
            raise explain_instagram_error(exc, target) from exc
    attach_library_state(scan)
    return public_scan_payload(scan, page, session=session)


@app.post("/api/highlights/stories")
def collection_detail(
    request: StoriesRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    scan = session.scans.get(scan_key(target, request.mode))
    if not scan:
        raise HTTPException(status_code=409, detail="Scan this profile again first.")

    highlight = next(
        (item for item in scan_collections(scan) if item["id"] == request.highlight_id),
        None,
    )
    if not highlight:
        raise HTTPException(status_code=404, detail="That highlight was not found.")

    hydrate_collection(session, highlight)
    highlight.update(collection_library_state(account_directory(scan["profile"]), highlight))
    account_dir = account_directory(scan["profile"])
    local_highlight_dir = find_collection_directory(account_dir, highlight["id"], request.mode)
    local_manifest = (
        read_json(local_highlight_dir / "manifest.json")
        if local_highlight_dir else {}
    )
    local_records = {
        str(record.get("id", "")): record
        for record in manifest_media(local_manifest)
        if isinstance(record, dict) and not record.get("removed_from_instagram")
    }
    stories = []
    for story in collection_media(highlight):
        local_record = local_records.get(str(story["id"]))
        local_available = bool(
            local_highlight_dir
            and local_record
            and record_file_is_valid(local_highlight_dir, local_record)
        )
        local_url = (
            f"http://127.0.0.1:8787/api/library/media/"
            f"{scan['profile']['id']}/{highlight['id']}/{story['id']}?mode={request.mode}"
            if local_available else ""
        )
        stories.append(
            {
                key: value
                for key, value in story.items()
                if key != "media_url"
            }
            | {
                "source_url": local_url or story["media_url"],
                "preview_url": local_url or story["media_url"],
                "download_url": f"{local_url}&download=true" if local_url else "",
                "local_available": local_available,
            }
        )

    return {
        "profile_username": scan["profile"]["username"],
        "post" if request.mode == "posts" else "highlight": {
            key: value
            for key, value in highlight.items()
            if key not in {"stories", "files", "folder_name", "media_loaded", "cover_source_url"}
        },
        "files" if request.mode == "posts" else "stories": stories,
    }


@app.post("/api/library/sync", status_code=202)
def prepare_collection_sync(
    request: LibrarySyncRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, str]:
    session = get_session(session_token)
    target = clean_target(request.target_username)
    scan = session.scans.get(scan_key(target, request.mode))
    if not scan:
        raise HTTPException(status_code=409, detail="Show this profile again first.")
    if any(job.get("status") == "working" for job in session.jobs.values()):
        raise HTTPException(
            status_code=409,
            detail="Another local library update is already running in this session.",
        )

    highlights = [
        item for item in scan_collections(scan)
        if not request.highlight_id or item["id"] == request.highlight_id
    ]
    if request.undownloaded_only and not request.highlight_id:
        highlights = [
            item for item in highlights
            if int(item.get("downloaded_count", 0) or 0)
            < int(item.get("item_count", 0) or 0)
        ]
    if request.highlight_id and not highlights:
        raise HTTPException(status_code=404, detail="That highlight was not found.")

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "target": target,
        "collection_id": request.highlight_id or "",
        "mode": request.mode,
        "created_at": time.time(),
        "status": "working",
        "completed_collections": 0,
        "total_collections": len(highlights),
        "current_collection": "",
        "current_file": 0,
        "current_file_total": 0,
        "processed_items": 0,
        "total_items": sum(int(item.get("item_count", 0)) for item in highlights),
        "downloaded_items": 0,
        "reused_items": 0,
        "failed_items": 0,
        "errors": [],
        "error": "",
    }
    session.jobs[job_id] = job

    def sync_library() -> None:
        working_scan = scan
        working_highlights = highlights
        try:
            if not request.highlight_id:
                working_scan = fetch_profile_scan(session, target, request.mode)
                if request.mode == "posts":
                    while working_scan.get("has_more"):
                        job["current_collection"] = f"Finding posts: {len(scan_collections(working_scan))} found"
                        time.sleep(2)
                        fetch_posts_page(session, working_scan)
                attach_library_state(working_scan)
                working_highlights = [
                    item for item in scan_collections(working_scan)
                    if not request.undownloaded_only
                    or int(item.get("downloaded_count", 0) or 0)
                    < int(item.get("item_count", 0) or 0)
                ]
                session.scans[scan_key(target, request.mode)] = working_scan
                job["total_collections"] = len(working_highlights)
                job["total_items"] = sum(
                    int(item.get("item_count", 0)) for item in working_highlights
                )

            account_dir = account_directory(working_scan["profile"], create=True)
            for index, highlight in enumerate(working_highlights, start=1):
                job["current_collection"] = highlight["title"]
                job["current_file"] = 0
                job["current_file_total"] = 0
                if (request.undownloaded_only or request.mode == "posts") and index > 1:
                    time.sleep(CONTINUE_HIGHLIGHT_DELAY_SECONDS)
                try:
                    if request.mode == "posts":
                        highlight["media_loaded"] = False
                        hydrate_collection(session, highlight)
                    else:
                        with session.request_lock:
                            detail = raw_highlight_detail(session.client, highlight["id"])
                        highlight["title"] = str(
                            model_value(detail, "title", "") or highlight["title"]
                        )
                        highlight["stories"] = normalize_stories(detail)
                        highlight["item_count"] = len(collection_media(highlight))
                        highlight["media_loaded"] = True
                        detailed_cover = cover_url(detail)
                        if detailed_cover and not highlight.get("cover_url"):
                            highlight["cover_url"] = proxy_media_url(
                                session,
                                detailed_cover,
                                f"highlight-{highlight['id']}-cover.jpg",
                            )
                    job["total_items"] = sum(
                        len(collection_media(item))
                        if item.get("media_loaded")
                        else int(item.get("item_count", 0))
                        for item in working_highlights
                    )
                    reconcile_collection(session, account_dir, highlight, job)
                except Exception as exc:
                    if isinstance(exc, HTTPException) and exc.status_code in {401, 403, 429}:
                        raise
                    if isinstance(
                        exc,
                        (
                            ChallengeRequired,
                            ClientThrottledError,
                            FeedbackRequired,
                            LoginRequired,
                            PleaseWaitFewMinutes,
                        ),
                    ):
                        raise
                    detail_message = (
                        str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
                    )
                    job["failed_items"] += max(int(highlight.get("item_count", 0)), 1)
                    job["errors"].append(f"{highlight['title']}: {detail_message}")
                job["completed_collections"] = index
                save_account_manifest(
                    account_dir,
                    working_scan,
                    full_sync=(
                        not bool(request.highlight_id)
                        and index == len(working_highlights)
                    ),
                )

            if not working_highlights:
                save_account_manifest(account_dir, working_scan, full_sync=True)
            attach_library_state(working_scan)
            job["current_collection"] = ""
            job["current_file"] = 0
            job["current_file_total"] = 0
            job["completed_at"] = time.time()
            if job["errors"]:
                job["status"] = "partial"
                job["error"] = (
                    f"{len(job['errors'])} item or highlight update failed. "
                    "Run the update again to retry only what is still missing."
                )
            else:
                job["status"] = "complete"
        except Exception as exc:
            if isinstance(exc, HTTPException):
                job["error"] = str(exc.detail)
            elif isinstance(
                exc,
                (
                    ChallengeRequired,
                    ClientThrottledError,
                    FeedbackRequired,
                    LoginRequired,
                    PleaseWaitFewMinutes,
                ),
            ):
                job["error"] = str(explain_instagram_error(exc, target).detail)
            else:
                job["error"] = str(exc)
            job["completed_at"] = time.time()
            job["status"] = "error"

    threading.Thread(target=sync_library, daemon=True).start()
    return {"job_id": job_id}


@app.post("/api/posts/scan")
def scan_posts(
    request: PostsScanRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    return scan_profile(ScanRequest(target_username=request.target_username, mode="posts"), session_token)


@app.post("/api/posts/page")
def posts_page(
    request: PostsPageRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    return scan_profile_page(HighlightsPageRequest(target_username=request.target_username, mode="posts", page=request.page), session_token)


@app.post("/api/posts/media")
def post_media(
    request: PostMediaRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    return collection_detail(StoriesRequest(target_username=request.target_username, mode="posts", highlight_id=request.post_id), session_token)


@app.post("/api/posts/sync", status_code=202)
def sync_posts(
    request: PostsSyncRequest,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, str]:
    return prepare_collection_sync(LibrarySyncRequest(
        target_username=request.target_username, mode="posts", highlight_id=request.post_id,
        undownloaded_only=request.undownloaded_only,
    ), session_token)


@app.get("/api/jobs/{job_id}")
def get_job(
    job_id: str,
    session_token: str | None = Header(default=None, alias="X-Keepsake-Session"),
) -> dict[str, Any]:
    session = get_session(session_token)
    job = session.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Library update job not found.")
    return dict(job)


def saved_collection_summary(directory: Path, user_id: str, mode: str = "highlights") -> dict[str, Any] | None:
    manifest = read_json(directory / "manifest.json")
    highlight_id = str(manifest.get("id", ""))
    if not highlight_id:
        return None
    records = [
        record for record in manifest_media(manifest)
        if isinstance(record, dict) and record.get("local_path") and record.get("size")
    ]
    if not records:
        return None
    cover = next(
        (
            record for record in records
            if record.get("type") == "image" and record_file_is_valid(directory, record)
        ),
        None,
    )
    cover_url = (
        f"http://127.0.0.1:8787/api/library/media/"
        f"{user_id}/{highlight_id}/{cover['id']}?mode={mode}"
        if cover else ""
    )
    return {
        "id": highlight_id,
        "kind": mode,
        "caption": str(manifest.get("caption", "")),
        "taken_at": str(manifest.get("taken_at", "")),
        "title": str(manifest.get("title", "")) or "Highlight",
        "cover_url": cover_url,
        "item_count": len(records),
        "position": int(manifest.get("position", 0) or 0),
        "local_status": "current",
        "downloaded_count": len(records),
        "removed_count": sum(bool(record.get("removed_from_instagram")) for record in records),
        "failed_count": 0,
        "last_updated_at": str(manifest.get("last_checked_at", "")),
        "is_old": False,
        "has_local": True,
    }


@app.get("/api/library")
def list_saved_accounts(mode: Literal["highlights", "posts"] = Query(default="highlights")) -> dict[str, Any]:
    accounts = []
    for directory in DOWNLOAD_ROOT.iterdir() if DOWNLOAD_ROOT.exists() else []:
        if not directory.is_dir():
            continue
        profile = read_json(directory / "account.json").get("profile") or {}
        if not isinstance(profile, dict) or not profile.get("id"):
            continue
        highlights_root = directory / mode
        saved_count = 0
        saved_collections = 0
        for highlight_dir in highlights_root.iterdir() if highlights_root.exists() else []:
            if not highlight_dir.is_dir():
                continue
            highlight = saved_collection_summary(highlight_dir, str(profile["id"]), mode)
            if highlight:
                saved_count += highlight["downloaded_count"]
                saved_collections += 1
        if not saved_count:
            continue
        accounts.append({
            "id": str(profile["id"]),
            "username": str(profile.get("username", "")),
            "full_name": str(profile.get("full_name", "")),
            "downloaded_files" if mode == "posts" else "downloaded_stories": saved_count,
            "saved_posts" if mode == "posts" else "saved_highlights": saved_collections,
        })
    accounts.sort(key=lambda account: account["username"].casefold())
    return {"mode": mode, "accounts": accounts}


@app.get("/api/library/{user_id}")
def get_saved_account(
    user_id: str, page: int = Query(default=1, ge=1),
    mode: Literal["highlights", "posts"] = Query(default="highlights"),
) -> dict[str, Any]:
    account_dir = find_account_directory(user_id)
    if not account_dir:
        raise HTTPException(status_code=404, detail="That local account was not found.")
    profile = read_json(account_dir / "account.json").get("profile") or {}
    if not isinstance(profile, dict):
        profile = {}
    highlights_root = account_dir / mode
    highlights = []
    for directory in highlights_root.iterdir() if highlights_root.exists() else []:
        if not directory.is_dir():
            continue
        highlight = saved_collection_summary(directory, user_id, mode)
        if highlight:
            highlights.append(highlight)
    highlights.sort(key=lambda highlight: (highlight["position"], highlight["id"]))
    page_size = HIGHLIGHTS_PER_PAGE
    total_pages = max(1, (len(highlights) + page_size - 1) // page_size)
    if page > total_pages:
        raise HTTPException(status_code=404, detail="That saved highlight page was not found.")
    saved_count = sum(highlight["downloaded_count"] for highlight in highlights)
    return {
        "mode": mode,
        "has_more": False,
        "profile": {
            "id": str(profile.get("id", user_id)),
            "username": str(profile.get("username", "")),
            "full_name": str(profile.get("full_name", "")),
            "profile_pic_url": "",
            "is_private": bool(profile.get("is_private", False)),
            "downloaded_files" if mode == "posts" else "downloaded_stories": saved_count,
            "undownloaded_files" if mode == "posts" else "undownloaded_stories": 0,
            "has_local": saved_count > 0,
            "is_old": False,
            "old_posts" if mode == "posts" else "old_highlights": 0,
            "last_updated_at": str(profile.get("last_updated_at", "")),
        },
        mode: highlights[(page - 1) * page_size:page * page_size],
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "total_posts" if mode == "posts" else "total_highlights": len(highlights),
        "total_files" if mode == "posts" else "total_stories": saved_count,
    }


@app.get("/api/library/{user_id}/highlights/{highlight_id}")
def get_saved_highlight(
    user_id: str, highlight_id: str,
    mode: Literal["highlights", "posts"] = Query(default="highlights"),
) -> dict[str, Any]:
    account_dir = find_account_directory(user_id)
    if not account_dir:
        raise HTTPException(status_code=404, detail="That local account was not found.")
    directory = find_collection_directory(account_dir, highlight_id, mode)
    if not directory:
        raise HTTPException(status_code=404, detail="That local highlight was not found.")
    highlight = saved_collection_summary(directory, user_id, mode)
    if not highlight:
        raise HTTPException(status_code=404, detail="That highlight has no valid local files.")
    manifest = read_json(directory / "manifest.json")
    stories = []
    for record in manifest_media(manifest):
        if not isinstance(record, dict) or not record_file_is_valid(directory, record):
            continue
        media_url = (
            f"http://127.0.0.1:8787/api/library/media/"
            f"{user_id}/{highlight_id}/{record['id']}?mode={mode}"
        )
        stories.append({
            "id": str(record["id"]),
            "position": int(record.get("position", 0) or 0),
            "type": "video" if record.get("type") == "video" else "image",
            "filename": str(record.get("filename", "")),
            "source_url": media_url,
            "preview_url": media_url,
            "download_url": media_url + "&download=true",
            "local_available": True,
            "taken_at": str(record.get("taken_at", "")),
            "removed_from_instagram": bool(record.get("removed_from_instagram")),
        })
    stories.sort(key=lambda story: (story["position"], story["id"]))
    if not stories:
        raise HTTPException(status_code=404, detail="That highlight has no valid local files.")
    highlight["item_count"] = len(stories)
    highlight["downloaded_count"] = len(stories)
    highlight["removed_count"] = sum(story["removed_from_instagram"] for story in stories)
    return {"post" if mode == "posts" else "highlight": highlight, "files" if mode == "posts" else "stories": stories}


@app.get("/api/library/{user_id}/posts/{post_id}")
def get_saved_post(user_id: str, post_id: str) -> dict[str, Any]:
    return get_saved_highlight(user_id, post_id, mode="posts")


@app.get("/api/library/{user_id}/export")
def export_library(
    user_id: str,
    highlight_id: str | None = Query(default=None),
    mode: Literal["highlights", "posts"] = Query(default="highlights"),
) -> StreamingResponse:
    account_dir = find_account_directory(user_id)
    if not account_dir:
        raise HTTPException(status_code=404, detail="No local files were found for this profile.")
    account_manifest = read_json(account_dir / "account.json")
    username = safe_name(
        str((account_manifest.get("profile") or {}).get("username", "")),
        "instagram",
        30,
    )
    stream = zipstream.ZipStream(compress_type=zipstream.ZIP_STORED)
    added = 0
    highlights_root = account_dir / mode
    for directory in highlights_root.iterdir() if highlights_root.exists() else []:
        if not directory.is_dir():
            continue
        manifest = read_json(directory / "manifest.json")
        if highlight_id and str(manifest.get("id", "")) != highlight_id:
            continue
        export_folder = (
            f"{int(manifest.get('position', 0)) + 1:03d}__"
            f"{safe_name(str(manifest.get('title', '')), 'Highlight', 60)}__"
            f"ig_{'post' if mode == 'posts' else 'highlight'}_{safe_name(str(manifest.get('id', '')), 'unknown', 50)}"
        )
        for record in manifest_media(manifest):
            if not isinstance(record, dict) or not record_file_is_valid(directory, record):
                continue
            path = local_record_path(directory, record)
            if not path:
                continue
            relative_folder = Path(username) / export_folder
            if record.get("removed_from_instagram"):
                relative_folder /= "_removed_from_instagram"
            stream.add_path(
                path,
                arcname=(relative_folder / str(record["filename"])).as_posix(),
            )
            added += 1
    if not added:
        raise HTTPException(status_code=404, detail="There are no valid local files to export.")
    suffix = f"-{highlight_id}" if highlight_id else ""
    archive_name = (
        f"{username}-saved-{mode}{suffix}-"
        f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    )
    return StreamingResponse(
        stream,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{archive_name}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/library/media/{user_id}/{highlight_id}/{story_id}")
def local_story_media(
    user_id: str,
    highlight_id: str,
    story_id: str,
    download: bool = False,
    mode: Literal["highlights", "posts"] = Query(default="highlights"),
) -> FileResponse:
    account_dir = find_account_directory(user_id)
    if not account_dir:
        raise HTTPException(status_code=404, detail="That local account was not found.")
    directory = find_collection_directory(account_dir, highlight_id, mode)
    if not directory:
        raise HTTPException(status_code=404, detail="That local highlight was not found.")
    manifest = read_json(directory / "manifest.json")
    record = next(
        (
            item for item in manifest_media(manifest)
            if isinstance(item, dict) and str(item.get("id", "")) == story_id
        ),
        None,
    )
    if not record or not record_file_is_valid(directory, record):
        raise HTTPException(status_code=404, detail="That local story file is missing or invalid.")
    path = local_record_path(directory, record)
    if not path:
        raise HTTPException(status_code=404, detail="That local story file is unavailable.")
    media_type = {
        ".mp4": "video/mp4",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(path.suffix.casefold(), "image/jpeg")
    return FileResponse(
        path,
        media_type=media_type,
        filename=record["filename"] if download else None,
        content_disposition_type="attachment" if download else "inline",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/api/media/{token}")
def download_story_media(token: str, download: bool = False) -> StreamingResponse:
    expire_inactive_sessions()
    session: BrowserSession | None = None
    media: dict[str, str] | None = None
    with sessions_lock:
        for candidate in browser_sessions.values():
            if token in candidate.media:
                session = candidate
                media = candidate.media[token]
                candidate.last_seen = time.time()
                break
    if not session or not media:
        raise HTTPException(
            status_code=404,
            detail="This media link expired. Open the highlight again.",
        )

    def stream_media() -> Iterator[bytes]:
        yield from media_chunks(session, media["url"])

    disposition = "attachment" if download else "inline"
    suffix = Path(media["filename"]).suffix.lower()
    media_type = {
        ".mp4": "video/mp4",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix, "image/jpeg")
    return StreamingResponse(
        stream_media(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{media["filename"]}"',
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )
