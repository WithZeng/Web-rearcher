"""Literature Researcher V3 -- multi-agent pipeline.

Usage:
    python main.py "[GelMA] AND [microsphere] AND [drug release]"
    python main.py "[GelMA] AND [drug release]" --limit 100 --output csv xlsx
    python main.py "[GelMA]" --limit 50 --output notion --resume
    python main.py "[GelMA]" --no-planner   # skip LLM-based search planning
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from lit_researcher import config
from lit_researcher.output import write_csv, write_excel, write_json, write_bibtex
from lit_researcher.checkpoint import load_completed_ids, load_all_results, filter_unprocessed
from lit_researcher.agents.orchestrator import run_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("pipeline")


async def run(
    query: str,
    limit: int | None = None,
    outputs: list[str] | None = None,
    resume: bool = False,
    fetch_concurrency: int | None = None,
    llm_concurrency: int | None = None,
    databases: list[str] | None = None,
    use_planner: bool = True,
    mode: str = "multi",
) -> None:
    outputs = outputs or ["csv"]

    # --- Run pipeline (resume=True skips already-checkpointed papers) ---
    logger.info("Pipeline mode: %s", mode)
    rows = await run_pipeline(
        query=query,
        limit=limit,
        databases=databases,
        fetch_concurrency=fetch_concurrency,
        llm_concurrency=llm_concurrency,
        use_planner=use_planner,
        mode=mode,
        resume=resume,
    )

    # Merge new results with previously checkpointed ones
    if resume:
        prev = load_all_results()
        if prev:
            seen = {r.get("paper_id") or r.get("source_doi") for r in rows if r.get("paper_id") or r.get("source_doi")}
            for old in prev:
                old_id = old.get("paper_id") or old.get("source_doi")
                if old_id and old_id not in seen:
                    rows.append(old)
            logger.info("Resume: merged %d new + %d previous = %d total rows", len(rows) - len(prev), len(prev), len(rows))

    if not rows:
        logger.warning("Pipeline returned no results.")
        return

    # --- Write outputs ---
    _write_outputs(rows, outputs)


def _write_outputs(rows: list[dict], outputs: list[str]) -> None:
    if not rows:
        logger.warning("No data to write.")
        return

    if "csv" in outputs:
        path = write_csv(rows)
        logger.info("CSV saved: %s", path)

    if "xlsx" in outputs:
        path = write_excel(rows)
        logger.info("Excel saved: %s", path)

    if "json" in outputs:
        path = write_json(rows)
        logger.info("JSON saved: %s", path)

    if "bib" in outputs:
        path = write_bibtex(rows)
        logger.info("BibTeX saved: %s", path)

    if "notion" in outputs:
        try:
            from lit_researcher.notion_writer import write_rows
            count = write_rows(rows)
            logger.info("Notion: wrote %d pages.", count)
        except Exception as e:
            logger.error("Notion write failed: %s", e)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Literature Researcher V3 -- multi-agent pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python main.py "[GelMA] AND [drug release]" --limit 50\n'
            '  python main.py "[GelMA]" --limit 100 --output csv xlsx\n'
            '  python main.py "[GelMA]" --output notion --resume\n'
            '  python main.py "[GelMA]" --mode single   # unified extraction\n'
            '  python main.py "[GelMA]" --mode multi     # 4 sub-agents (default)\n'
        ),
    )
    parser.add_argument("query", help="Search query (findpapers syntax: [term1] AND [term2])")
    parser.add_argument("--limit", type=int, default=None, help="Max papers to retrieve")
    parser.add_argument(
        "--output", nargs="+", choices=["csv", "xlsx", "json", "bib", "notion"],
        default=["csv"], dest="outputs",
        help="Output formats (default: csv)",
    )
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    parser.add_argument("--fetch-concurrency", type=int, default=None, help="Concurrent downloads (default: 20)")
    parser.add_argument("--llm-concurrency", type=int, default=None, help="Concurrent LLM calls (default: 10)")
    parser.add_argument(
        "--databases", nargs="+",
        default=None,
        help="Databases to search (default: OpenAlex PubMed 'Semantic Scholar' CrossRef)",
    )
    parser.add_argument(
        "--no-planner", action="store_true",
        help="Skip LLM-based search strategy planning",
    )
    parser.add_argument(
        "--mode", choices=["single", "multi"], default="multi",
        help="Pipeline mode: 'single' (unified extraction) or 'multi' (4 sub-agents, default)",
    )

    args = parser.parse_args()
    asyncio.run(run(
        query=args.query,
        limit=args.limit,
        outputs=args.outputs,
        resume=args.resume,
        fetch_concurrency=args.fetch_concurrency,
        llm_concurrency=args.llm_concurrency,
        databases=args.databases,
        use_planner=not args.no_planner,
        mode=args.mode,
    ))


if __name__ == "__main__":
    main()
