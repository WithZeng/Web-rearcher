"""lit_researcher -- automated literature search, fetch, and extraction pipeline."""

from .config import FIELDS, ALL_DATABASES, DEFAULT_DATABASES
from .search import search_papers
from .fetch import fetch_all, fetch_one
from .extract import extract_fields, extract_one, extract_batch
from .output import write_csv, write_excel
from .checkpoint import load_completed_ids, load_all_results, append_result

__all__ = [
    "FIELDS",
    "ALL_DATABASES",
    "DEFAULT_DATABASES",
    "search_papers",
    "fetch_all",
    "fetch_one",
    "extract_fields",
    "extract_one",
    "extract_batch",
    "write_csv",
    "write_excel",
    "load_completed_ids",
    "load_all_results",
    "append_result",
]
