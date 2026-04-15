"""Lightweight GROBID REST client for structured PDF parsing.

Sends PDF bytes to a local GROBID instance and returns clean text
with tables converted to markdown.  Falls back gracefully if GROBID
is unavailable.
"""

from __future__ import annotations

import logging
import re
from xml.etree import ElementTree as ET

import requests

from . import config

logger = logging.getLogger(__name__)

_NS = {"tei": "http://www.tei-c.org/ns/1.0"}
_TIMEOUT = 120


def _grobid_process(pdf_bytes: bytes) -> str:
    """Send PDF to GROBID /api/processFulltextDocument and return raw TEI XML."""
    url = f"{config.GROBID_URL.rstrip('/')}/api/processFulltextDocument"
    resp = requests.post(
        url,
        files={"input": ("paper.pdf", pdf_bytes, "application/pdf")},
        data={
            "consolidateHeader": "1",
            "consolidateCitations": "0",
            "includeRawAffiliations": "0",
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.text


def _extract_sections(root: ET.Element) -> dict[str, str]:
    """Extract named sections from TEI body."""
    sections: dict[str, str] = {}
    body = root.find(".//tei:body", _NS)
    if body is None:
        return sections

    for div in body.findall(".//tei:div", _NS):
        head = div.find("tei:head", _NS)
        section_name = (head.text or "").strip() if head is not None else ""
        paragraphs = []
        for p in div.findall("tei:p", _NS):
            text = "".join(p.itertext()).strip()
            if text:
                paragraphs.append(text)
        if paragraphs:
            sections[section_name] = "\n".join(paragraphs)

    return sections


def _extract_tables(root: ET.Element) -> list[str]:
    """Extract tables from TEI and format as simple markdown."""
    tables: list[str] = []
    for fig in root.findall(".//tei:figure[@type='table']", _NS):
        caption_el = fig.find("tei:head", _NS)
        caption = "".join(caption_el.itertext()).strip() if caption_el is not None else ""

        rows: list[list[str]] = []
        for row in fig.findall(".//tei:row", _NS):
            cells = []
            for cell in row.findall("tei:cell", _NS):
                cells.append("".join(cell.itertext()).strip())
            if cells:
                rows.append(cells)

        if not rows:
            content = "".join(fig.itertext()).strip()
            if content:
                tables.append(f"[TABLE] {caption}\n{content}\n[/TABLE]")
            continue

        md_lines = []
        if caption:
            md_lines.append(f"[TABLE] {caption}")
        header = rows[0]
        md_lines.append("| " + " | ".join(header) + " |")
        md_lines.append("| " + " | ".join("---" for _ in header) + " |")
        for row in rows[1:]:
            padded = row + [""] * (len(header) - len(row))
            md_lines.append("| " + " | ".join(padded[:len(header)]) + " |")
        md_lines.append("[/TABLE]")
        tables.append("\n".join(md_lines))

    return tables


def _extract_abstract(root: ET.Element) -> str:
    """Extract abstract text."""
    abstract = root.find(".//tei:profileDesc/tei:abstract", _NS)
    if abstract is None:
        return ""
    return " ".join("".join(p.itertext()).strip() for p in abstract.findall(".//tei:p", _NS))


def parse_pdf_grobid(pdf_bytes: bytes) -> str:
    """Parse PDF via GROBID and return structured text string.

    Output format: tables first (markdown), then abstract, then sections.
    Designed to be backward-compatible (returns a plain string).
    """
    xml_str = _grobid_process(pdf_bytes)
    xml_str = re.sub(r'xmlns="[^"]*"', '', xml_str, count=1)
    root = ET.fromstring(xml_str)

    # Re-add namespace for xpath
    for elem in root.iter():
        if elem.tag.startswith("{"):
            _, _, elem.tag = elem.tag.rpartition("}")

    parts: list[str] = []

    tables = _extract_tables(root)
    if tables:
        parts.append("=== TABLES ===")
        parts.extend(tables)
        parts.append("")

    abstract = _extract_abstract(root)
    if abstract:
        parts.append("=== ABSTRACT ===")
        parts.append(abstract)
        parts.append("")

    sections = _extract_sections(root)
    if sections:
        parts.append("=== FULL TEXT ===")
        for name, text in sections.items():
            if name:
                parts.append(f"\n## {name}")
            parts.append(text)

    result = "\n\n".join(parts)
    logger.info("GROBID parsed PDF: %d chars, %d tables, %d sections",
                len(result), len(tables), len(sections))
    return result
