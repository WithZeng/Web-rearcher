from __future__ import annotations


class _FakePages:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.updated: list[dict] = []

    def create(self, **kwargs):
        self.created.append(kwargs)

    def update(self, **kwargs):
        self.updated.append(kwargs)


class _FakeClient:
    def __init__(self) -> None:
        self.pages = _FakePages()


def test_passes_quality_gate_requires_gelma_priority_fields():
    import lit_researcher.notion_writer as notion_writer

    weak_row = {
        "_data_quality": 0.5,
        "drug_name": "DOX",
        "gelma_concentration": "5",
    }
    strong_row = {
        "_data_quality": 0.5,
        "drug_name": "DOX",
        "gelma_concentration": "5",
        "release_time": "72",
    }

    assert notion_writer._passes_quality_gate(weak_row) is False
    assert notion_writer._passes_quality_gate(strong_row) is True


def test_smart_push_marks_duplicate_doi_as_pushed(monkeypatch):
    import lit_researcher.notion_writer as notion_writer

    client = _FakeClient()
    monkeypatch.setattr(notion_writer, "_get_client", lambda: client)
    monkeypatch.setattr(notion_writer, "ensure_database", lambda _client: "db")
    monkeypatch.setattr(notion_writer, "query_existing_dois", lambda _db_id: {"10.1/test"})
    monkeypatch.setattr(notion_writer, "_get_data_source_id", lambda _client, _db_id: "ds")
    monkeypatch.setattr(notion_writer, "_passes_quality_gate", lambda _row: True)
    monkeypatch.setattr(notion_writer.time, "sleep", lambda _seconds: None)

    rows = [{"source_doi": "10.1/test", "source_title": "Known paper", "drug_name": "A"}]

    result = notion_writer.smart_push(rows)

    assert result["pushed"] == 0
    assert result["patched"] == 0
    assert result["skipped_duplicate"] == 1
    assert result["pushed_dois"] == ["10.1/test"]
    assert rows[0]["_pushed_to_notion"]


def test_smart_push_marks_patched_doi_as_pushed(monkeypatch):
    import lit_researcher.notion_writer as notion_writer

    client = _FakeClient()
    monkeypatch.setattr(notion_writer, "_get_client", lambda: client)
    monkeypatch.setattr(notion_writer, "ensure_database", lambda _client: "db")
    monkeypatch.setattr(
        notion_writer,
        "query_existing_pages",
        lambda _db_id: {"10.1/test": {"page_id": "page-1", "values": {}}},
    )
    monkeypatch.setattr(notion_writer, "_get_data_source_id", lambda _client, _db_id: "ds")
    monkeypatch.setattr(notion_writer, "_passes_quality_gate", lambda _row: True)
    monkeypatch.setattr(notion_writer, "_compute_patch", lambda _row, _values: {"Field": {"rich_text": []}})
    monkeypatch.setattr(notion_writer.time, "sleep", lambda _seconds: None)

    rows = [{"source_doi": "10.1/test", "source_title": "Patched paper", "drug_name": "A"}]

    result = notion_writer.smart_push(rows, patch_existing=True)

    assert result["pushed"] == 0
    assert result["patched"] == 1
    assert result["skipped_duplicate"] == 0
    assert result["pushed_dois"] == ["10.1/test"]
    assert client.pages.updated
    assert rows[0]["_pushed_to_notion"]
