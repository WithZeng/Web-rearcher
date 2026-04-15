import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)
PDF_CACHE_DIR = OUTPUT_DIR / "pdfs"
PDF_CACHE_DIR.mkdir(exist_ok=True)
CHECKPOINT_PATH = OUTPUT_DIR / "checkpoint.jsonl"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
API_TYPE = os.getenv("API_TYPE", "openai")  # "openai" | "anthropic"
MAX_RESULTS = int(os.getenv("MAX_RESULTS", "5"))

FETCH_CONCURRENCY = int(os.getenv("FETCH_CONCURRENCY", "15"))
LLM_CONCURRENCY = int(os.getenv("LLM_CONCURRENCY", "5"))

NOTION_TOKEN = os.getenv("NOTION_TOKEN", "")
NOTION_PARENT_PAGE_ID = os.getenv("NOTION_PARENT_PAGE_ID", "")
NOTION_DB_NAME = os.getenv("NOTION_DB_NAME", "GelMA 高质量文献库")

IEEE_API_KEY = os.getenv("IEEE_API_KEY", "")
SCOPUS_API_KEY = os.getenv("SCOPUS_API_KEY", "")

UNPAYWALL_EMAIL = os.getenv("UNPAYWALL_EMAIL", "")

HTTP_PROXY = os.getenv("HTTP_PROXY", "") or os.getenv("HTTPS_PROXY", "")

GROBID_URL = os.getenv("GROBID_URL", "")  # e.g. "http://localhost:8070"

MAX_TEXT_LEN = 30_000

ALL_DATABASES = [
    "OpenAlex", "PubMed", "Semantic Scholar", "CrossRef",
    "Google Scholar", "arXiv", "IEEE", "Scopus",
]
DEFAULT_DATABASES = ["OpenAlex", "PubMed", "Semantic Scholar", "CrossRef"]

FIELDS = [
    # GelMA 微球 (A-H)
    "gelma_concentration",
    "degree_of_substitution",
    "gelma_molecular_weight",
    "microsphere_size",
    "drug_microsphere_ratio",
    "encapsulation_efficiency",
    "drug_loading_rate",
    "drug_loading_amount",
    # 药物特征 (I-Q)
    "drug_name",
    "drug_molecular_weight",
    "tpsa",
    "hbd",
    "hba",
    "drug_nha",
    "drug_melting_point",
    "pka",
    "drug_logp",
    # 环境特征 (R-T)
    "temperature",
    "ph",
    "release_time",
    # 目标量 (U)
    "release_amount",
    # 文献来源
    "source_title",
    "source_doi",
]
