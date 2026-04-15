"""Base classes for the multi-agent pipeline."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class PipelineContext:
    """Shared state passed between agents in the pipeline."""

    query: str
    limit: int
    databases: list[str]
    fetch_concurrency: int
    llm_concurrency: int

    # Populated by SearchAgent
    papers: list[dict] = field(default_factory=list)

    # Populated by RetrievalAgent
    papers_with_text: list[dict] = field(default_factory=list)

    # Populated by QualityFilterAgent
    passed_papers: list[dict] = field(default_factory=list)
    failed_papers: list[dict] = field(default_factory=list)

    # Populated by sub-extraction agents (multi-agent mode)
    _gelma_results: list[dict] = field(default_factory=list)
    _drug_results: list[dict] = field(default_factory=list)
    _release_results: list[dict] = field(default_factory=list)
    _source_results: list[dict] = field(default_factory=list)

    # Populated by ExtractionAgent or merged from sub-agents
    rows: list[dict] = field(default_factory=list)

    # Populated by ReviewerAgent
    reviewed_rows: list[dict] = field(default_factory=list)
    _retry_queue: list[dict] = field(default_factory=list)

    # Bookkeeping
    logs: list[str] = field(default_factory=list)
    retry_count: int = 0

    # Pipeline mode: "single" (one ExtractionAgent) or "multi" (4 sub-agents)
    mode: str = "multi"

    # Real-time activity callback (set by orchestrator)
    _on_activity: Callable[[str], Any] | None = field(default=None, repr=False)

    # Cancellation check — should raise if the task has been cancelled
    _cancel_check: Callable[[], None] | None = field(default=None, repr=False)

    def check_cancelled(self) -> None:
        """Raise if the task has been cancelled by the user."""
        if self._cancel_check:
            self._cancel_check()

    def emit_activity(self, text: str) -> None:
        """Send a fine-grained activity message to the frontend."""
        self.check_cancelled()
        if self._on_activity:
            self._on_activity(text)


class BaseAgent:
    """Abstract base for all pipeline agents."""

    name: str = "BaseAgent"

    async def run(self, ctx: PipelineContext) -> PipelineContext:
        raise NotImplementedError

    def _log(self, ctx: PipelineContext, msg: str) -> None:
        entry = f"[{self.name}] {msg}"
        ctx.logs.append(entry)
        logger.info(entry)

    async def run_timed(self, ctx: PipelineContext) -> PipelineContext:
        """Run with timing and logging."""
        self._log(ctx, "started")
        t0 = time.monotonic()
        ctx = await self.run(ctx)
        elapsed = time.monotonic() - t0
        self._log(ctx, f"finished in {elapsed:.1f}s")
        return ctx
