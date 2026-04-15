"""ReviewerAgent — rule-based quality review with detailed scoring and flags."""

from __future__ import annotations

import re

from .base import BaseAgent, PipelineContext


def _safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _try_float(val) -> float | None:
    """Parse a numeric value that may contain ranges (e.g. '10-20') or ± notation.

    Returns the first number.  Handles leading negatives correctly.
    """
    if val is None:
        return None
    try:
        s = str(val).strip()
        if not s:
            return None
        s = s.split("±")[0].strip()
        if s.startswith("-"):
            rest = s[1:].split("-")[0].strip()
            return float("-" + rest) if rest else None
        return float(s.split("-")[0].strip())
    except (ValueError, IndexError):
        return None


def _check_range(val, lo: float, hi: float, name: str) -> str | None:
    """Return a flag string if val is outside [lo, hi], else None."""
    f = _try_float(val)
    if f is not None and (f < lo or f > hi):
        return f"{name}={f} out of range [{lo},{hi}]"
    return None


def review_row(row: dict) -> dict:
    """Review a single extracted row.

    Returns a dict with:
      - review_score (0-100)
      - review_flags (list of issue strings)
      - needs_retry (bool)
      - _review ("ok" / "low_quality" / "suspicious")
    """
    flags: list[str] = []
    score = 100

    quality = row.get("_data_quality", 0) or 0

    # --- Completeness check ---
    if quality < 0.05:
        flags.append("almost_empty: <5% fields filled")
        score -= 50
    elif quality < 0.15:
        flags.append("very_sparse: <15% fields filled")
        score -= 30
    elif quality < 0.3:
        flags.append("sparse: <30% fields filled")
        score -= 15

    # --- Numeric range checks ---
    range_checks = [
        ("ph", 0, 14),
        ("temperature", 0, 200),
        ("encapsulation_efficiency", 0, 100),
        ("drug_loading_rate", 0, 100),
        ("release_amount", 0, 100),
        ("gelma_concentration", 0, 100),
    ]
    for field, lo, hi in range_checks:
        flag = _check_range(row.get(field), lo, hi, field)
        if flag:
            flags.append(flag)
            score -= 10

    # --- Unit confusion heuristic ---
    size = row.get("microsphere_size")
    if isinstance(size, str) and re.search(r"\d{4,}", size):
        flags.append(f"microsphere_size may have unit issue: {size}")
        score -= 5

    # --- Key field presence ---
    critical_missing = 0
    for field in ["drug_name", "gelma_concentration", "source_title"]:
        if not row.get(field):
            critical_missing += 1
    if critical_missing >= 2:
        flags.append(f"missing {critical_missing} critical fields")
        score -= 15

    # --- DOI/title consistency ---
    doi = row.get("source_doi", "")
    title = row.get("source_title", "")
    if doi and not title:
        flags.append("has DOI but no title")
        score -= 5
    if title and not doi:
        flags.append("has title but no DOI")

    # --- Release data presence ---
    has_time = row.get("release_time") is not None
    has_amount = row.get("release_amount") is not None
    if not has_time and not has_amount:
        flags.append("no release_time or release_amount")
        score -= 10

    # --- Cross-consistency: drug_loading_rate should not exceed encapsulation_efficiency ---
    ee = _try_float(row.get("encapsulation_efficiency"))
    dlr = _try_float(row.get("drug_loading_rate"))
    if ee is not None and dlr is not None and dlr > ee:
        flags.append(f"drug_loading_rate ({dlr}) > encapsulation_efficiency ({ee})")
        score -= 15

    # --- GelMA concentration typical range (0.5-50%) ---
    gc = _try_float(row.get("gelma_concentration"))
    if gc is not None and (gc < 0.5 or gc > 50):
        flags.append(f"gelma_concentration unusual: {gc}%")
        score -= 10

    # --- Microsphere size typical range (1-5000 μm) ---
    ms = row.get("microsphere_size")
    if ms:
        nums = re.findall(r"[\d.]+", str(ms))
        if nums:
            valid_nums = [float(n) for n in nums if float(n) > 0]
            if valid_nums:
                max_size = max(valid_nums)
                if max_size < 1 or max_size > 5000:
                    flags.append(f"microsphere_size out of typical range: {ms}")
                    score -= 10

    # --- Confidence reliability: too many inferred vs paper values ---
    conf = row.get("_confidence", {}) or {}
    if isinstance(conf, dict):
        inferred_count = sum(1 for v in conf.values() if v == "inferred")
        paper_count = sum(1 for v in conf.values() if v == "paper")
        if inferred_count > 5 and paper_count < 3:
            flags.append(f"too many inferred values ({inferred_count}) vs paper ({paper_count})")
            score -= 20

    score = max(0, min(100, score))

    if score >= 70:
        label = "ok"
    elif score >= 40:
        label = "low_quality"
    else:
        label = "suspicious"

    needs_retry = label == "suspicious" and quality < 0.15

    return {
        "review_score": score,
        "review_flags": flags,
        "needs_retry": needs_retry,
        "_review": label,
    }


class ReviewerAgent(BaseAgent):
    name = "ReviewerAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        reviewed: list[dict] = []
        retry_queue: list[dict] = []
        counts = {"ok": 0, "low_quality": 0, "suspicious": 0}
        total = len(ctx.rows)

        for i, row in enumerate(ctx.rows):
            if i % 3 == 0:
                ctx.emit_activity(f"审查 [{i + 1}/{total}] {row.get('source_title', '?')[:40]}...")
            verdict = review_row(row)
            enriched = {
                **row,
                "_review": verdict["_review"],
                "_review_score": verdict["review_score"],
                "_review_flags": "; ".join(verdict["review_flags"]) if verdict["review_flags"] else "",
            }
            reviewed.append(enriched)
            counts[verdict["_review"]] += 1

            if verdict["needs_retry"] and i < len(ctx.passed_papers):
                retry_queue.append(ctx.passed_papers[i])

        ctx.reviewed_rows = reviewed
        ctx._retry_queue = retry_queue

        self._log(
            ctx,
            f"reviewed {len(reviewed)} rows: {counts}, "
            f"retry_queue={len(retry_queue)}",
        )
        return ctx
