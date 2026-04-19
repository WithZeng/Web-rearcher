"""Write extraction results to a Notion database."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime
from notion_client import Client as NotionClient

from . import config
from .ui_helpers import FIELD_LABELS

logger = logging.getLogger(__name__)

_NOTION_RATE_DELAY = 0.35


def _safe_float(value: object, default: float = 0.0) -> float:
    if value is None:
        return default
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _label(field: str) -> str:
    """Get the Chinese display label for a field, falling back to the raw name."""
    return FIELD_LABELS.get(field, field)


def _build_property_schema() -> dict:
    """Dynamically build Notion property schema using Chinese column names."""
    schema = {}
    for field in config.FIELDS:
        label = _label(field)
        if field == "source_doi":
            schema[label] = {"url": {}}
        else:
            schema[label] = {"rich_text": {}}
    schema[_label("_data_quality")] = {"number": {"format": "percent"}}
    schema[_label("text_source")] = {"select": {}}
    return schema


def _get_client() -> NotionClient:
    if not config.NOTION_TOKEN:
        raise ValueError("NOTION_TOKEN not set in .env")
    return NotionClient(auth=config.NOTION_TOKEN)


def _get_data_source_id(client: NotionClient, database_id: str) -> str:
    """Retrieve the primary data_source_id for a database (notion-client >= 3.0 / API 2025-09-03)."""
    db = client.databases.retrieve(database_id=database_id)
    data_sources = db.get("data_sources", [])
    if not data_sources:
        raise ValueError(f"Database {database_id} has no data sources")
    return data_sources[0]["id"]


def _sync_database_schema(client: NotionClient, ds_id: str) -> None:
    """Add any missing properties to an existing Notion data source (API 2025-09-03)."""
    ds = client.data_sources.retrieve(data_source_id=ds_id)
    existing_props = set(ds.get("properties", {}).keys())
    desired = _build_property_schema()

    missing = {k: v for k, v in desired.items() if k not in existing_props}
    if not missing:
        return

    try:
        client.data_sources.update(data_source_id=ds_id, properties=missing)
        logger.info("Synced %d missing properties to data source: %s", len(missing), list(missing.keys()))
    except Exception as e:
        logger.error("Failed to sync data source schema: %s", e)
        raise


def _get_db_title(block: dict) -> str:
    """Extract plain-text title from a child_database block."""
    title = block.get("child_database", {}).get("title", "")
    if isinstance(title, str):
        return title
    if isinstance(title, list):
        return "".join(t.get("plain_text", "") if isinstance(t, dict) else str(t) for t in title)
    return str(title)


def ensure_database(client: NotionClient | None = None) -> str:
    """Find or create the Notion database (matched by NOTION_DB_NAME). Returns database_id."""
    client = client or _get_client()
    parent_id = config.NOTION_PARENT_PAGE_ID
    if not parent_id:
        raise ValueError("NOTION_PARENT_PAGE_ID not set in .env")

    target_name = config.NOTION_DB_NAME or "GelMA 高质量文献库"

    children = client.blocks.children.list(block_id=parent_id)
    for block in children.get("results", []):
        if block.get("type") == "child_database":
            title = _get_db_title(block)
            if title == target_name:
                db_id = block["id"]
                ds_id = _get_data_source_id(client, db_id)
                _sync_database_schema(client, ds_id)
                logger.info("Found existing Notion DB '%s': %s", target_name, db_id)
                return db_id

    db = client.databases.create(
        parent={"type": "page_id", "page_id": parent_id},
        title=[{"type": "text", "text": {"content": target_name}}],
        initial_data_source={"properties": _build_property_schema()},
    )
    logger.info("Created Notion database '%s': %s", target_name, db["id"])
    return db["id"]


def _row_to_properties(row: dict) -> dict:
    """Convert an extraction result dict to Notion page properties (Chinese column names)."""
    props = {}
    for field in config.FIELDS:
        label = _label(field)
        val = row.get(field)
        if val is None:
            val = ""
        val = str(val)

        if field == "source_doi":
            doi_url = val if val.startswith("http") else f"https://doi.org/{val}" if val else ""
            props[label] = {"url": doi_url or None}
        else:
            props[label] = {"rich_text": [{"text": {"content": val[:2000]}}]}

    quality = row.get("_data_quality")
    if quality is not None:
        props[_label("_data_quality")] = {"number": _safe_float(quality)}

    text_source = row.get("text_source", "")
    if text_source:
        props[_label("text_source")] = {"select": {"name": text_source}}

    return props


def _compute_patch(local_row: dict, notion_values: dict) -> dict:
    """Compare local row with Notion values and return Notion-format properties for empty fields.

    Only includes fields where Notion is empty but local has data.
    Uses internal field keys for comparison, Chinese labels for Notion property names.
    """
    patch_props: dict = {}
    for field in config.FIELDS:
        if field == "source_doi":
            continue
        notion_val = str(notion_values.get(field) or "").strip()
        local_val = str(local_row.get(field) or "").strip()
        if not notion_val and local_val:
            patch_props[_label(field)] = {"rich_text": [{"text": {"content": local_val[:2000]}}]}

    notion_quality = notion_values.get("_data_quality")
    local_quality = local_row.get("_data_quality")
    if notion_quality is None and local_quality is not None:
        patch_props[_label("_data_quality")] = {"number": _safe_float(local_quality)}

    return patch_props


def _patch_page(client: NotionClient, page_id: str, patch_props: dict) -> bool:
    """Update a single Notion page with the given property patch. Returns True on success."""
    try:
        client.pages.update(page_id=page_id, properties=patch_props)
        return True
    except Exception as e:
        logger.error("Failed to patch Notion page %s: %s", page_id, e)
        return False


def write_rows(rows: list[dict], database_id: str | None = None) -> int:
    """Write rows to Notion. Returns count of pages created."""
    client = _get_client()
    db_id = database_id or ensure_database(client)
    ds_id = _get_data_source_id(client, db_id)
    count = 0

    for row in rows:
        props = _row_to_properties(row)
        try:
            client.pages.create(
                parent={"type": "data_source_id", "data_source_id": ds_id},
                properties=props,
            )
            count += 1
        except Exception as e:
            logger.error("Failed to write row to Notion: %s", e)
        time.sleep(_NOTION_RATE_DELAY)

    logger.info("Wrote %d/%d rows to Notion", count, len(rows))
    return count


async def write_rows_async(rows: list[dict], database_id: str | None = None) -> int:
    """Async wrapper around the synchronous Notion writes."""
    return await asyncio.to_thread(write_rows, rows, database_id)


def query_existing_dois(database_id: str | None = None) -> set[str]:
    """Query all DOIs already in the Notion database."""
    client = _get_client()
    db_id = database_id or ensure_database(client)
    ds_id = _get_data_source_id(client, db_id)
    dois: set[str] = set()
    doi_label = _label("source_doi")
    start_cursor = None

    while True:
        kwargs: dict = {"data_source_id": ds_id, "page_size": 100}
        if start_cursor:
            kwargs["start_cursor"] = start_cursor
        resp = client.data_sources.query(**kwargs)
        for page in resp.get("results", []):
            props = page.get("properties", {})
            doi_prop = props.get(doi_label, {})
            url = doi_prop.get("url", "")
            if url:
                doi = url.replace("https://doi.org/", "").replace("http://doi.org/", "")
                if doi:
                    dois.add(doi)
        if not resp.get("has_more"):
            break
        start_cursor = resp.get("next_cursor")

    logger.info("Found %d existing DOIs in Notion", len(dois))
    return dois


def _extract_page_values(props: dict) -> dict:
    """Extract plain values from Notion page properties (Chinese column names) for comparison.

    Returns a dict keyed by internal field names (e.g. 'gelma_concentration').
    """
    values: dict = {}
    for field in config.FIELDS:
        label = _label(field)
        prop = props.get(label, {})
        if field == "source_doi":
            url = prop.get("url", "") or ""
            values[field] = url.replace("https://doi.org/", "").replace("http://doi.org/", "")
        else:
            rt = prop.get("rich_text", [])
            values[field] = rt[0].get("plain_text", "") if rt else ""
    quality_prop = props.get(_label("_data_quality"), {})
    values["_data_quality"] = quality_prop.get("number") if quality_prop else None
    return values


def query_existing_pages(database_id: str | None = None) -> dict[str, dict]:
    """Query all pages in Notion and return doi -> {page_id, values} mapping.

    ``values`` is a flat dict of field -> plain string extracted from Notion
    properties, suitable for comparison with local rows.
    """
    client = _get_client()
    db_id = database_id or ensure_database(client)
    ds_id = _get_data_source_id(client, db_id)
    pages: dict[str, dict] = {}
    doi_label = _label("source_doi")
    start_cursor = None

    while True:
        kwargs: dict = {"data_source_id": ds_id, "page_size": 100}
        if start_cursor:
            kwargs["start_cursor"] = start_cursor
        resp = client.data_sources.query(**kwargs)
        for page in resp.get("results", []):
            props = page.get("properties", {})
            doi_prop = props.get(doi_label, {})
            url = doi_prop.get("url", "") or ""
            doi = url.replace("https://doi.org/", "").replace("http://doi.org/", "")
            if doi:
                pages[doi] = {
                    "page_id": page["id"],
                    "values": _extract_page_values(props),
                }
        if not resp.get("has_more"):
            break
        start_cursor = resp.get("next_cursor")

    logger.info("Loaded %d existing pages from Notion (with full values)", len(pages))
    return pages


_MIN_PUSH_QUALITY = 0.15
_MIN_CORE_COUNT = 2
_MIN_PRIORITY_COUNT = 2
_PRIMARY_EXPERIMENT_FIELDS = [
    "gelma_concentration",
    "microsphere_size",
    "encapsulation_efficiency",
    "release_amount",
    "release_time",
]
_RELEASE_FIELDS = ["release_amount", "release_time"]
_FORMULATION_FIELDS = ["gelma_concentration", "microsphere_size", "encapsulation_efficiency"]


def _filled_field_count(row: dict, fields: list[str]) -> int:
    return sum(1 for field in fields if str(row.get(field) or "").strip())


def _quality_gate_reason(row: dict) -> str | None:
    from .output import _CORE_FIELDS

    q = _safe_float(row.get("_data_quality"))
    if q < _MIN_PUSH_QUALITY:
        return "low_quality"
    if not str(row.get("drug_name") or "").strip():
        return "missing_drug_name"

    core_count = _filled_field_count(row, list(_CORE_FIELDS))
    if core_count < _MIN_CORE_COUNT:
        return "insufficient_core_fields"

    primary_count = _filled_field_count(row, _PRIMARY_EXPERIMENT_FIELDS)
    if primary_count < _MIN_PRIORITY_COUNT:
        return "insufficient_priority_fields"

    release_count = _filled_field_count(row, _RELEASE_FIELDS)
    formulation_count = _filled_field_count(row, _FORMULATION_FIELDS)
    if release_count == 0 and formulation_count < 2:
        return "missing_release_or_formulation_signal"

    return None


def _passes_quality_gate(row: dict) -> bool:
    """Check if a row meets the minimum quality bar for Notion push.

    Requirements:
      1. _data_quality >= 15%  (at least 3 of 19 fields)
      2. drug_name must be present
      3. At least 2 core fields filled
    """
    return _quality_gate_reason(row) is None


def smart_push(
    rows: list[dict],
    database_id: str | None = None,
    on_progress: Callable[[dict], None] | None = None,
    patch_existing: bool = False,
) -> dict:
    """Filter, deduplicate, then push to Notion.

    When *patch_existing* is True, duplicate DOIs are not simply skipped.
    Instead, their Notion page properties are compared field-by-field with
    the local data, and any empty Notion fields are patched with local values.

    Returns stats: {
      pushed, skipped_quality, skipped_duplicate, patched, total,
      pushed_dois, marked_dois
    }.
    """
    def _emit(data: dict) -> None:
        if on_progress:
            on_progress(data)

    _emit({"phase": "init", "message": "正在连接 Notion..."})
    client = _get_client()
    db_id = database_id or ensure_database(client)

    if patch_existing:
        _emit({"phase": "dedup", "message": "正在读取 Notion 数据库完整数据（用于对比补全）..."})
        existing_pages = query_existing_pages(db_id)
        existing_dois = set(existing_pages.keys())
    else:
        _emit({"phase": "dedup", "message": "正在查询已有 DOI 去重..."})
        existing_dois = query_existing_dois(db_id)
        existing_pages = {}

    to_push: list[dict] = []
    to_patch: list[tuple[dict, str, dict]] = []  # (local_row, page_id, patch_props)
    skipped_quality = 0
    skipped_dup = 0
    for r in rows:
        if not _passes_quality_gate(r):
            skipped_quality += 1
            continue
        doi = (r.get("source_doi") or "").strip()
        if doi and doi in existing_dois:
            if patch_existing and doi in existing_pages:
                page_info = existing_pages[doi]
                patch_props = _compute_patch(r, page_info["values"])
                if patch_props:
                    to_patch.append((r, page_info["page_id"], patch_props))
                else:
                    skipped_dup += 1
            else:
                skipped_dup += 1
            continue
        to_push.append(r)

    total_to_push = len(to_push)
    patch_msg = f"，{len(to_patch)} 条待补全" if to_patch else ""
    _emit({
        "phase": "filter_done",
        "message": f"筛选完成：{total_to_push} 条待推送，{skipped_quality} 条质量过滤，{skipped_dup} 条重复跳过{patch_msg}",
        "to_push": total_to_push,
        "skipped_quality": skipped_quality,
        "skipped_duplicate": skipped_dup,
        "to_patch": len(to_patch),
    })

    ds_id = _get_data_source_id(client, db_id)
    pushed = 0
    failed = 0
    pushed_dois: list[str] = []
    marked_dois: set[str] = set()
    now_iso = datetime.now().isoformat()

    total_work = total_to_push + len(to_patch)
    work_idx = 0

    for i, row in enumerate(to_push):
        work_idx += 1
        title = (row.get("source_title") or "")[:60]
        _emit({
            "phase": "pushing",
            "current": work_idx,
            "total": total_work,
            "pushed": pushed,
            "failed": failed,
            "message": f"推送 [{work_idx}/{total_work}] {title}...",
        })
        props = _row_to_properties(row)
        try:
            client.pages.create(
                parent={"type": "data_source_id", "data_source_id": ds_id},
                properties=props,
            )
            pushed += 1
            row["_pushed_to_notion"] = now_iso
            doi = (row.get("source_doi") or "").strip()
            if doi:
                pushed_dois.append(doi)
                marked_dois.add(doi)
        except Exception as e:
            failed += 1
            logger.error("Failed to write row to Notion: %s", e)
        time.sleep(_NOTION_RATE_DELAY)

    patched = 0
    for row, page_id, patch_props in to_patch:
        work_idx += 1
        title = (row.get("source_title") or "")[:60]
        n_fields = len(patch_props)
        _emit({
            "phase": "patching",
            "current": work_idx,
            "total": total_work,
            "pushed": pushed,
            "patched": patched,
            "failed": failed,
            "message": f"补全 [{work_idx}/{total_work}] {title}（{n_fields} 个字段）...",
        })
        doi = (row.get("source_doi") or "").strip()
        if _patch_page(client, page_id, patch_props):
            patched += 1
            row["_pushed_to_notion"] = now_iso
            if doi:
                marked_dois.add(doi)
        else:
            failed += 1
        time.sleep(_NOTION_RATE_DELAY)

    # Any DOI already existing in Notion (including skipped duplicates and rows queued for patch)
    # should be eligible for local history pushed-mark backfill.
    for r in rows:
        doi = (r.get("source_doi") or "").strip()
        if doi and doi in existing_dois:
            if not r.get("_pushed_to_notion"):
                r["_pushed_to_notion"] = now_iso
            marked_dois.add(doi)

    logger.info(
        "Smart push: %d pushed, %d patched, %d quality-filtered, %d duplicates",
        pushed, patched, skipped_quality, skipped_dup,
    )
    result = {
        "pushed": pushed,
        "patched": patched,
        "skipped_quality": skipped_quality,
        "skipped_duplicate": skipped_dup,
        "total": len(rows),
        "pushed_dois": sorted(marked_dois),
        "marked_dois": sorted(marked_dois),
    }
    _emit({"phase": "done", **result})
    return result


async def smart_push_async(rows: list[dict], database_id: str | None = None) -> dict:
    return await asyncio.to_thread(smart_push, rows, database_id)


def test_notion_connection() -> tuple[bool, str]:
    """Test if Notion credentials are valid."""
    try:
        client = _get_client()
        db_id = ensure_database(client)
        ds_id = _get_data_source_id(client, db_id)
        client.data_sources.query(data_source_id=ds_id, page_size=1)
        return True, "连接成功，数据库已就绪"
    except ValueError as e:
        return False, str(e)
    except Exception as e:
        return False, f"连接失败: {e}"


def notion_db_status() -> dict:
    """Get Notion database status."""
    try:
        client = _get_client()
        db_id = ensure_database(client)
        ds_id = _get_data_source_id(client, db_id)
        total = 0
        cursor = None
        while True:
            kwargs: dict = {"data_source_id": ds_id, "page_size": 100}
            if cursor:
                kwargs["start_cursor"] = cursor
            resp = client.data_sources.query(**kwargs)
            total += len(resp.get("results", []))
            if not resp.get("has_more"):
                break
            cursor = resp.get("next_cursor")
        return {"connected": True, "database_id": db_id, "record_count": total}
    except Exception as e:
        return {"connected": False, "error": str(e), "record_count": 0}
