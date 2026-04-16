"""Shared helpers for the Streamlit UI (app.py).

Extracted to keep app.py focused on layout and interaction.
"""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Any

import pandas as pd
from dotenv import dotenv_values

import lit_researcher.config as config
from lit_researcher.config import FIELDS
from lit_researcher.output import write_excel, write_json, write_bibtex, ALL_COLUMNS, ALL_CN

_HISTORY_DIR = config.OUTPUT_DIR / "history"
_HISTORY_DIR.mkdir(exist_ok=True)

_MODELS_FILE = config.BASE_DIR / "models.json"

FIELD_LABELS: dict[str, str] = {
    "gelma_concentration": "GelMA浓度/concentration(%)",
    "degree_of_substitution": "取代度(接枝率)/degree of substitution",
    "gelma_molecular_weight": "GelMA分子量/KDa",
    "microsphere_size": "微球粒径分布/μm",
    "drug_microsphere_ratio": "药物微球质量比(药物/微球)",
    "encapsulation_efficiency": "包封率/%",
    "drug_loading_rate": "载药率/%",
    "drug_loading_amount": "载药量",
    "drug_name": "药物名称",
    "drug_molecular_weight": "药物分子量",
    "tpsa": "拓扑极性表面积TPSA",
    "hbd": "氢键供体数(HBD)",
    "hba": "氢键受体数(HBA)",
    "drug_nha": "杂原子数量Drug_NHA",
    "drug_melting_point": "熔点Drug_Tm",
    "pka": "酸解离常数(pKa)",
    "drug_logp": "计算分配系数Drug_LogP",
    "temperature": "温度/°C",
    "ph": "pH",
    "release_time": "释放时间/h",
    "release_amount": "释放量/%release",
    "source_title": "文献来源",
    "source_doi": "DOI",
    "_data_quality": "数据质量",
    "text_source": "文本来源",
    "_review": "审查结果",
    "_review_score": "审查分数",
    "_review_flags": "审查问题",
    "_quality_label": "质量等级",
    "_quality_total": "质量总分",
    "_pushed_to_notion": "已推送到Notion",
}

RECOMMENDED_QUERIES = [
    "GelMA microsphere drug release",
    "gelatin methacryloyl microsphere controlled release",
    "GelMA hydrogel microsphere encapsulation efficiency",
    "GelMA microparticle drug loading",
    "GelMA microsphere sustained release kinetics",
    "photo-crosslinked gelatin microsphere drug delivery",
    "GelMA microgel drug release pH responsive",
    "GelMA microsphere fabrication characterization",
    "methacrylated gelatin microsphere therapeutic agent",
    "GelMA microcarrier protein drug release",
]


# ── Async bridge ─────────────────────────────────────────────────────────────


def run_async(coro):
    """Run an async coroutine from sync Streamlit context."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    else:
        return asyncio.run(coro)


# ── Model management ─────────────────────────────────────────────────────────


def load_models() -> list[dict]:
    if _MODELS_FILE.exists():
        try:
            return json.loads(_MODELS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            pass
    return []


def save_models(models: list[dict]) -> None:
    _MODELS_FILE.write_text(json.dumps(models, ensure_ascii=False, indent=2), encoding="utf-8")


def save_to_env(key: str, value: str) -> None:
    env_path = config.BASE_DIR / ".env"
    if env_path.exists():
        content = env_path.read_text(encoding="utf-8")
    else:
        content = ""
    pattern = rf"^{re.escape(key)}=.*$"
    replacement = f"{key}={value}"
    if re.search(pattern, content, re.MULTILINE):
        content = re.sub(pattern, replacement, content, flags=re.MULTILINE)
    else:
        content = content.rstrip("\n") + f"\n{replacement}\n"
    env_path.write_text(content, encoding="utf-8")


def apply_model(api_key: str, base_url: str, model_name: str, api_type: str = "") -> None:
    save_to_env("OPENAI_API_KEY", api_key)
    save_to_env("OPENAI_BASE_URL", base_url)
    save_to_env("OPENAI_MODEL", model_name)
    config.OPENAI_API_KEY = api_key
    config.OPENAI_BASE_URL = base_url
    config.OPENAI_MODEL = model_name
    if api_type:
        save_to_env("API_TYPE", api_type)
        config.API_TYPE = api_type


IMPORTABLE_ENV_KEYS = {
    "OPENAI_API_KEY": "OPENAI_API_KEY",
    "OPENAI_BASE_URL": "OPENAI_BASE_URL",
    "OPENAI_MODEL": "OPENAI_MODEL",
    "API_TYPE": "API_TYPE",
    "NOTION_TOKEN": "NOTION_TOKEN",
    "NOTION_PARENT_PAGE_ID": "NOTION_PARENT_PAGE_ID",
    "NOTION_DB_NAME": "NOTION_DB_NAME",
    "UNPAYWALL_EMAIL": "UNPAYWALL_EMAIL",
    "HTTP_PROXY": "HTTP_PROXY",
    "HTTPS_PROXY": "HTTP_PROXY",
    "IEEE_API_KEY": "IEEE_API_KEY",
    "SCOPUS_API_KEY": "SCOPUS_API_KEY",
    "MAX_RESULTS": "MAX_RESULTS",
    "FETCH_CONCURRENCY": "FETCH_CONCURRENCY",
    "LLM_CONCURRENCY": "LLM_CONCURRENCY",
}


def _set_runtime_config(key: str, value: str) -> None:
    if key in {"MAX_RESULTS", "FETCH_CONCURRENCY", "LLM_CONCURRENCY"}:
        setattr(config, key, int(value))
        return
    setattr(config, key, value)
    if key == "HTTP_PROXY":
        config.HTTP_PROXY = value


def import_env_text(env_text: str) -> dict[str, list[str]]:
    parsed = dotenv_values(stream=StringIO(env_text))

    imported: list[str] = []
    ignored: list[str] = []
    warnings: list[str] = []

    for raw_key, raw_value in parsed.items():
        if not raw_key:
            continue
        key = raw_key.strip()
        mapped_key = IMPORTABLE_ENV_KEYS.get(key)
        if not mapped_key:
            ignored.append(key)
            continue
        if raw_value is None:
            warnings.append(f"{key} 缺少值，已跳过")
            continue

        value = str(raw_value).strip()
        try:
            if mapped_key == "API_TYPE" and value not in {"openai", "anthropic"}:
                warnings.append(f"{key} 的值必须是 openai 或 anthropic，已跳过")
                continue
            if mapped_key in {"MAX_RESULTS", "FETCH_CONCURRENCY", "LLM_CONCURRENCY"}:
                int(value)

            save_to_env(mapped_key, value)
            _set_runtime_config(mapped_key, value)
            imported.append(mapped_key)
        except ValueError:
            warnings.append(f"{key} 需要是数字，已跳过")

    # Normalize proxy envs so runtime and .env stay aligned.
    if "HTTP_PROXY" in imported and "HTTPS_PROXY" not in parsed:
        save_to_env("HTTPS_PROXY", config.HTTP_PROXY)

    return {
        "imported": sorted(set(imported)),
        "ignored": sorted(set(ignored)),
        "warnings": warnings,
    }


def test_model_connection(api_key: str, base_url: str, model_name: str, api_type: str = "openai") -> tuple[bool, str]:
    if api_type == "anthropic":
        return _test_anthropic(api_key, base_url, model_name)

    from openai import OpenAI

    kwargs: dict[str, Any] = {"api_key": api_key, "timeout": 15.0}
    if base_url:
        kwargs["base_url"] = base_url
    try:
        client = OpenAI(**kwargs)
        resp = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": "Hi, reply with OK"}],
            max_tokens=5,
            temperature=0,
        )
        content = (resp.choices[0].message.content or "").strip()
        return True, f"连接成功 — 模型响应: {content}"
    except Exception as e:
        return False, f"连接失败: {e}"


def _normalize_anthropic_base_url(url: str) -> str:
    """Strip trailing Anthropic API path segments that the SDK appends automatically."""
    url = url.rstrip("/")
    for suffix in ("/v1/messages", "/v1/complete", "/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url


def _test_anthropic(api_key: str, base_url: str, model_name: str) -> tuple[bool, str]:
    try:
        from anthropic import Anthropic
    except ImportError:
        return False, "连接失败: 未安装 anthropic 库，请运行 pip install anthropic"
    kwargs: dict[str, Any] = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = _normalize_anthropic_base_url(base_url)
        # Relay/proxy stations typically expect Bearer auth instead of x-api-key
        kwargs["default_headers"] = {"Authorization": f"Bearer {api_key}"}
    try:
        client = Anthropic(**kwargs)
        resp = client.messages.create(
            model=model_name,
            max_tokens=16,
            temperature=0,
            messages=[{"role": "user", "content": "Hi, reply with OK"}],
        )
        parts = [b.text for b in resp.content if hasattr(b, "text")]
        content = "".join(parts).strip()
        return True, f"连接成功 — 模型响应: {content}"
    except Exception as e:
        return False, f"连接失败: {e}"


# ── Data export ──────────────────────────────────────────────────────────────


def df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


def df_to_excel_bytes(rows: list[dict]) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    write_excel(rows, path=tmp_path)
    data = tmp_path.read_bytes()
    tmp_path.unlink(missing_ok=True)
    return data


def rows_to_json_bytes(rows: list[dict]) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    write_json(rows, path=tmp_path)
    data = tmp_path.read_bytes()
    tmp_path.unlink(missing_ok=True)
    return data


def rows_to_bibtex_bytes(rows: list[dict]) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".bib", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    write_bibtex(rows, path=tmp_path)
    data = tmp_path.read_bytes()
    tmp_path.unlink(missing_ok=True)
    return data


# ── History management ───────────────────────────────────────────────────────


def save_task(
    query: str,
    rows: list[dict],
    databases: list[str] | None = None,
) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    task: dict = {
        "query": query,
        "timestamp": ts,
        "count": len(rows),
        "rows": rows,
        "search_metadata": {
            "databases": databases or [],
            "started_at": ts,
        },
    }
    path = _HISTORY_DIR / f"task_{ts}.json"
    path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def load_history() -> list[dict]:
    tasks = []
    for f in sorted(_HISTORY_DIR.glob("task_*.json"), reverse=True):
        try:
            tasks.append(json.loads(f.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, ValueError):
            continue
    return tasks


def delete_task(timestamp: str) -> None:
    path = _HISTORY_DIR / f"task_{timestamp}.json"
    path.unlink(missing_ok=True)


def cleanup_history(min_quality: float = 0.0) -> dict:
    """Permanently remove invalid rows from all history files.

    Removes rows that fail the quality gate:
      1. _data_quality < 15%
      2. Missing drug_name
      3. Fewer than 2 core fields filled
    If min_quality > 0, also removes rows below that threshold.
    Returns stats: {files_updated, rows_before, rows_after, removed}.
    """
    from .output import _CORE_FIELDS
    from .notion_writer import _MIN_PUSH_QUALITY, _MIN_CORE_COUNT

    threshold = max(min_quality, _MIN_PUSH_QUALITY)

    total_before = 0
    total_after = 0
    files_updated = 0

    for f in sorted(_HISTORY_DIR.glob("task_*.json")):
        try:
            task = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            continue
        rows = task.get("rows", [])
        total_before += len(rows)

        kept = []
        for r in rows:
            q = float(r.get("_data_quality") or 0)
            if q < threshold:
                continue
            if not str(r.get("drug_name") or "").strip():
                continue
            core_count = sum(1 for fld in _CORE_FIELDS if str(r.get(fld) or "").strip())
            if core_count < _MIN_CORE_COUNT:
                continue
            kept.append(r)

        total_after += len(kept)
        if len(kept) < len(rows):
            files_updated += 1
            task["rows"] = kept
            task["count"] = len(kept)
            if not kept:
                f.unlink(missing_ok=True)
            else:
                f.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "files_updated": files_updated,
        "rows_before": total_before,
        "rows_after": total_after,
        "removed": total_before - total_after,
    }


def _save_enriched_rows(enriched_rows: list[dict], history: list[dict]) -> None:
    """Write enriched data back to history files.

    Matches rows by DOI and updates fields in-place.
    """
    doi_to_enriched: dict[str, dict] = {}
    for row in enriched_rows:
        doi = _normalize_doi(row.get("source_doi") or "")
        if doi:
            doi_to_enriched[doi] = row

    for f in _HISTORY_DIR.glob("task_*.json"):
        try:
            task = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            continue

        changed = False
        for row in task.get("rows", []):
            doi = _normalize_doi(row.get("source_doi") or "")
            if doi and doi in doi_to_enriched:
                enriched = doi_to_enriched[doi]
                for key, val in enriched.items():
                    if key.startswith("_") and key != "_confidence":
                        continue
                    current = row.get(key)
                    if (current is None or not str(current).strip()) and val is not None and str(val).strip():
                        row[key] = val
                        changed = True

        if changed:
            f.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")


def mark_rows_pushed(dois: list[str]) -> int:
    """Mark rows in history files as pushed to Notion.

    Sets `_pushed_to_notion` = current ISO timestamp on every row whose
    normalized DOI appears in *dois*.  Returns the number of rows marked.
    """
    if not dois:
        return 0

    now_iso = datetime.now().isoformat()
    target_dois = {_normalize_doi(d) for d in dois if d.strip()}
    marked = 0

    for f in _HISTORY_DIR.glob("task_*.json"):
        try:
            task = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            continue

        changed = False
        for row in task.get("rows", []):
            if row.get("_pushed_to_notion"):
                continue
            doi = _normalize_doi(row.get("source_doi") or "")
            if doi and doi in target_dois:
                row["_pushed_to_notion"] = now_iso
                changed = True
                marked += 1

        if changed:
            f.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")

    return marked


def history_stats(history: list[dict]) -> dict:
    """Compute aggregate stats across all history tasks."""
    total_tasks = len(history)
    total_papers = sum(len(t.get("rows", [])) for t in history)
    all_rows = [r for t in history for r in t.get("rows", [])]

    avg_quality = 0.0
    if all_rows:
        qualities = [r.get("_data_quality", 0) for r in all_rows if r.get("_data_quality") is not None]
        avg_quality = sum(qualities) / len(qualities) if qualities else 0.0

    source_counts: dict[str, int] = {}
    for r in all_rows:
        src = r.get("text_source", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1

    return {
        "total_tasks": total_tasks,
        "total_papers": total_papers,
        "avg_quality": avg_quality,
        "source_counts": source_counts,
    }


def _normalize_doi(raw: str) -> str:
    """Strip URL prefixes and whitespace to get a canonical DOI."""
    d = raw.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "doi:"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d.strip("/").strip()


def _normalize_title(title: str) -> str:
    """Normalize title for dedup: lowercase, strip punctuation, truncate."""
    if not title:
        return ""
    return re.sub(r'[^\w]', '', title.lower().strip())[:120]


def load_history_dois() -> set[str]:
    """Return normalized DOIs of all papers already in history."""
    dois: set[str] = set()
    for f in _HISTORY_DIR.glob("task_*.json"):
        try:
            task = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            continue
        for row in task.get("rows", []):
            doi = _normalize_doi(row.get("source_doi") or "")
            if doi:
                dois.add(doi)
    return dois


def filter_history_duplicates(papers: list[dict]) -> tuple[list[dict], int]:
    """Remove papers whose DOI already exists in history.

    Returns (filtered_papers, skipped_count).
    """
    history_dois = load_history_dois()
    if not history_dois:
        return papers, 0
    kept = []
    for p in papers:
        doi = _normalize_doi(p.get("doi") or "")
        if doi and doi in history_dois:
            continue
        kept.append(p)
    return kept, len(papers) - len(kept)


def _row_quality_score(row: dict) -> float:
    """Compute a comparable quality score for dedup – higher is better."""
    q = float(row.get("_data_quality") or 0)
    ts = str(row.get("text_source") or "none")
    source_bonus = 0.0 if ts in ("none", "") else (0.3 if ts == "abstract" else 0.5)
    from .output import _CORE_FIELDS
    core_count = sum(1 for f in _CORE_FIELDS if row.get(f))
    _KEY_FIELDS = ["drug_name", "gelma_concentration", "source_title", "source_doi"]
    key_complete = 1.0 if all(str(row.get(k) or "").strip() for k in _KEY_FIELDS) else 0.0
    review_score = float(row.get("_review_score") or row.get("_quality_total") or 0)
    return q + source_bonus + core_count * 0.01 + key_complete + review_score * 0.001


def merge_history_rows(
    history: list[dict],
    *,
    min_quality: float = 0.0,
    remove_empty: bool = True,
    pushed_filter: str = "all",
) -> list[dict]:
    """Merge all history rows, deduplicating by DOI then title (keep best record).

    Args:
        min_quality: minimum _data_quality to include (0.0 = include all).
        remove_empty: if True, discard rows with quality=0 AND no core fields AND text_source=none.
        pushed_filter: "all" | "pushed" | "unpushed" — filter by Notion push status.
    """
    from .output import _CORE_FIELDS

    best_by_doi: dict[str, dict] = {}
    best_by_title: dict[str, dict] = {}
    no_key: list[dict] = []

    for task in history:
        for row in task.get("rows", []):
            doi = _normalize_doi(row.get("source_doi") or "")
            if doi:
                existing = best_by_doi.get(doi)
                if existing is None or _row_quality_score(row) > _row_quality_score(existing):
                    best_by_doi[doi] = row
            else:
                norm_title = _normalize_title(row.get("source_title") or "")
                if norm_title:
                    existing = best_by_title.get(norm_title)
                    if existing is None or _row_quality_score(row) > _row_quality_score(existing):
                        best_by_title[norm_title] = row
                else:
                    no_key.append(row)

    doi_titles = {_normalize_title(r.get("source_title") or "") for r in best_by_doi.values()}
    merged = list(best_by_doi.values())
    merged += [r for t, r in best_by_title.items() if t not in doi_titles]
    merged += no_key

    if remove_empty:
        result = []
        for r in merged:
            q = float(r.get("_data_quality") or 0)
            ts = str(r.get("text_source") or "none")
            has_core = any(r.get(f) for f in _CORE_FIELDS)
            if q <= 0 and ts == "none" and not has_core:
                continue
            result.append(r)
        merged = result

    if min_quality > 0:
        merged = [r for r in merged if float(r.get("_data_quality") or 0) >= min_quality]

    if pushed_filter == "pushed":
        merged = [r for r in merged if r.get("_pushed_to_notion")]
    elif pushed_filter == "unpushed":
        merged = [r for r in merged if not r.get("_pushed_to_notion")]

    merged.sort(key=lambda r: float(r.get("_data_quality") or 0), reverse=True)
    return merged


# ── DOI batch import ─────────────────────────────────────────────────────────


def parse_doi_list(text: str) -> list[str]:
    """Extract DOIs from pasted text (one per line, or comma-separated)."""
    dois = []
    for line in text.replace(",", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("https://doi.org/"):
            line = line[len("https://doi.org/"):]
        if line.startswith("http://doi.org/"):
            line = line[len("http://doi.org/"):]
        if "/" in line:
            dois.append(line)
    return dois


def dois_to_papers(dois: list[str]) -> list[dict]:
    """Convert a list of DOIs into paper dicts suitable for fetch_all."""
    return [
        {
            "paper_id": doi,
            "title": "",
            "doi": doi,
            "abstract": "",
            "pdf_url": None,
            "web_url": f"https://doi.org/{doi}",
        }
        for doi in dois
    ]
