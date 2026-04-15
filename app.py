"""Literature Researcher V2 -- Streamlit Web UI.

Launch:
    streamlit run app.py
"""

from __future__ import annotations

from typing import Any

import pandas as pd
import streamlit as st

import lit_researcher.config as config
from lit_researcher.config import FIELDS, ALL_DATABASES, DEFAULT_DATABASES
from lit_researcher.fetch import fetch_all
from lit_researcher.extract import extract_batch
from lit_researcher.output import ALL_COLUMNS, ALL_CN
from lit_researcher.agents.orchestrator import run_pipeline as agent_run_pipeline
from lit_researcher.ui_helpers import (
    FIELD_LABELS,
    RECOMMENDED_QUERIES,
    run_async,
    load_models,
    save_models,
    apply_model,
    test_model_connection,
    df_to_csv_bytes,
    df_to_excel_bytes,
    rows_to_json_bytes,
    rows_to_bibtex_bytes,
    save_task,
    load_history,
    delete_task,
    history_stats,
    merge_history_rows,
    parse_doi_list,
    dois_to_papers,
)

st.set_page_config(
    page_title="文献检索助手 V3",
    page_icon="🔬",
    layout="wide",
    menu_items={
        "About": "# 文献检索助手 V3\nMulti-Agent 文献自动化处理系统。",
        "Get help": None,
        "Report a bug": None,
    },
)


# ── Rendering helpers ────────────────────────────────────────────────────────


def _sanitize_df_for_arrow(df: pd.DataFrame) -> pd.DataFrame:
    """Cast mixed-type object columns to str so PyArrow can serialize them."""
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].map(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
    return df


def _render_results(rows: list[dict], query_label: str = "") -> None:
    """Render result table, download buttons, and detail expander."""
    df = pd.DataFrame(rows)
    display_cols = [f for f in ALL_COLUMNS if f in df.columns]
    df = df[display_cols]
    df_display = _sanitize_df_for_arrow(df.rename(columns={**FIELD_LABELS, **ALL_CN}))

    if query_label:
        st.subheader(f"提取结果 ({len(df)} 条) — {query_label}")
    else:
        st.subheader(f"提取结果 ({len(df)} 条)")

    if "_data_quality" in df.columns:
        avg_q = df["_data_quality"].dropna().mean()
        cols = st.columns(3)
        cols[0].metric("论文数", len(df))
        cols[1].metric("平均数据质量", f"{avg_q:.0%}" if pd.notna(avg_q) else "N/A")
        source_counts = df["text_source"].value_counts() if "text_source" in df.columns else pd.Series()
        cols[2].metric("全文获取率", f"{(1 - source_counts.get('none', 0) / max(len(df), 1)):.0%}")

    st.dataframe(df_display, width="stretch", hide_index=True)

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.download_button(
            label="CSV",
            data=df_to_csv_bytes(df),
            file_name="literature_results.csv",
            mime="text/csv",
            width="stretch",
            key=f"dl_csv_{id(rows)}",
        )
    with col2:
        st.download_button(
            label="Excel",
            data=df_to_excel_bytes(rows),
            file_name="literature_results.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            width="stretch",
            key=f"dl_xlsx_{id(rows)}",
        )
    with col3:
        st.download_button(
            label="JSON",
            data=rows_to_json_bytes(rows),
            file_name="literature_results.json",
            mime="application/json",
            width="stretch",
            key=f"dl_json_{id(rows)}",
        )
    with col4:
        st.download_button(
            label="BibTeX",
            data=rows_to_bibtex_bytes(rows),
            file_name="literature_results.bib",
            mime="text/plain",
            width="stretch",
            key=f"dl_bib_{id(rows)}",
        )

    with st.expander("查看每篇论文的详细提取数据"):
        for idx, row in enumerate(rows):
            title = row.get("source_title", f"论文 {idx + 1}")
            quality = row.get("_data_quality")
            quality_str = f" (质量: {quality:.0%})" if quality is not None else ""
            source = row.get("text_source", "")
            source_str = f" [{source}]" if source else ""
            review = row.get("_review", "")
            review_str = f" [{review}]" if review else ""
            st.markdown(f"**{idx + 1}. {title}{quality_str}{source_str}{review_str}**")

            review_score = row.get("_review_score")
            review_flags = row.get("_review_flags", "")
            quality_label = row.get("_quality_label", "")
            if review_score is not None or quality_label:
                meta_parts = []
                if review_score is not None:
                    meta_parts.append(f"审查分: {review_score}/100")
                if quality_label:
                    meta_parts.append(f"质量等级: {quality_label}")
                if review_flags:
                    meta_parts.append(f"问题: {review_flags}")
                st.caption(" | ".join(meta_parts))

            detail_df = pd.DataFrame(
                [
                    {"字段": FIELD_LABELS.get(k, k), "值": "" if v is None else str(v)}
                    for k, v in row.items()
                    if k in FIELDS
                ]
            )
            st.table(detail_df)
            if idx < len(rows) - 1:
                st.divider()


_STAGE_LABELS = {
    "planner": "Planner: 分析搜索策略...",
    "search": "SearchAgent: 搜索论文...",
    "retrieval": "RetrievalAgent: 获取全文...",
    "quality_filter": "QualityFilter: 质量分流...",
    "extraction": "ExtractionAgent: LLM 提取...",
    "extraction_sub_agents": "4个子Agent并行提取中...",
    "extraction_merge": "合并子Agent结果...",
    "reviewer": "ReviewerAgent: 审查结果...",
    "reviewer_retry": "ReviewerAgent: 重试低质量数据...",
}


def _run_pipeline(
    query: str,
    limit: int,
    databases: list[str] | None = None,
    fetch_conc: int | None = None,
    llm_conc: int | None = None,
    use_planner: bool = True,
    mode: str = "multi",
) -> list[dict[str, Any]]:
    """Execute the pipeline with live UI updates."""
    stage_container = st.container()
    progress = st.progress(0, text="启动 Agent 流水线...")
    stages_done = {"count": 0}
    if mode == "multi":
        total_stages = (1 if use_planner else 0) + 6
    else:
        total_stages = (1 if use_planner else 0) + 5

    def on_stage(stage_name, ctx):
        stages_done["count"] += 1
        frac = min(stages_done["count"] / total_stages, 1.0)
        label = _STAGE_LABELS.get(stage_name, stage_name)
        progress.progress(frac, text=f"[{stages_done['count']}/{total_stages}] {label}")
        with stage_container:
            if stage_name == "search":
                st.write(f"SearchAgent: 找到 {len(ctx.papers)} 篇论文")
            elif stage_name == "retrieval":
                fetched = sum(1 for p in ctx.papers_with_text if p.get("text"))
                st.write(f"RetrievalAgent: 获取全文 {fetched}/{len(ctx.papers_with_text)} 篇")
            elif stage_name == "quality_filter":
                high = sum(1 for p in ctx.passed_papers if p.get("_quality_scores", {}).get("quality_label") == "high_value")
                medium = sum(1 for p in ctx.passed_papers if p.get("_quality_scores", {}).get("quality_label") == "medium_value")
                st.write(f"QualityFilter: 通过 {len(ctx.passed_papers)} (高={high}, 中={medium}), 失败 {len(ctx.failed_papers)}")
            elif stage_name == "extraction":
                st.write(f"ExtractionAgent: 提取 {len(ctx.rows)} 条结果")
            elif stage_name == "extraction_merge":
                st.write(f"子Agent合并: {len(ctx.rows)} 条结果")
            elif stage_name == "reviewer":
                counts = {}
                for r in ctx.reviewed_rows:
                    v = r.get("_review", "ok")
                    counts[v] = counts.get(v, 0) + 1
                retry_n = len(getattr(ctx, "_retry_queue", []))
                st.write(f"ReviewerAgent: {counts}" + (f", 重试队列: {retry_n}" if retry_n else ""))

    rows = run_async(agent_run_pipeline(
        query=query,
        limit=limit,
        databases=databases,
        fetch_concurrency=fetch_conc,
        llm_concurrency=llm_conc,
        use_planner=use_planner,
        on_stage=on_stage,
        mode=mode,
    ))
    progress.progress(1.0, text="Agent 流水线完成")
    return list(rows) if rows else []


def _run_doi_pipeline(
    dois: list[str],
    fetch_conc: int | None = None,
    llm_conc: int | None = None,
    mode: str = "multi",
) -> list[dict[str, Any]]:
    """Fetch and extract from a list of DOIs using agent sub-pipeline."""
    fc = fetch_conc or config.FETCH_CONCURRENCY
    lc = llm_conc or config.LLM_CONCURRENCY
    papers = dois_to_papers(dois)
    total = len(papers)

    progress = st.progress(0, text=f"正在获取 {total} 篇 DOI 论文全文...")

    papers_with_text = run_async(fetch_all(papers, max_concurrent=fc))
    fetched_count = sum(1 for p in papers_with_text if p.get("text"))
    progress.progress(0.33, text=f"全文获取完成: {fetched_count}/{total} 篇")

    from lit_researcher.agents.quality_filter import QualityFilterAgent
    from lit_researcher.agents.extraction_agent import ExtractionAgent
    from lit_researcher.agents.reviewer import ReviewerAgent
    from lit_researcher.agents.base import PipelineContext
    from lit_researcher.agents.orchestrator import _run_sub_agents_parallel, _merge_sub_results

    async def _doi_sub_pipeline():
        ctx = PipelineContext(
            query=f"DOI import ({total})",
            limit=total,
            databases=[],
            fetch_concurrency=fc,
            llm_concurrency=lc,
            mode=mode,
        )
        ctx.papers_with_text = list(papers_with_text)
        ctx = await QualityFilterAgent().run(ctx)

        if mode == "multi":
            ctx = await _run_sub_agents_parallel(ctx)
            _merge_sub_results(ctx)
        else:
            ctx = await ExtractionAgent().run(ctx)

        ctx = await ReviewerAgent().run(ctx)
        return ctx.reviewed_rows

    rows = run_async(_doi_sub_pipeline())
    progress.progress(1.0, text=f"提取完成: {len(rows)}/{total} 篇")
    return list(rows) if rows else []


# ── Sidebar ──────────────────────────────────────────────────────────────────

with st.sidebar:
    st.header("检索参数")
    preset = st.selectbox(
        "推荐检索词",
        options=["自定义"] + RECOMMENDED_QUERIES,
        index=0,
    )
    default_query = "" if preset == "自定义" else preset
    query = st.text_input(
        "搜索关键词",
        value=default_query,
        placeholder="例如: GelMA microsphere drug release",
    )
    limit = st.number_input("最大论文数", min_value=1, value=config.MAX_RESULTS, step=1)

    selected_dbs = st.multiselect(
        "检索数据库",
        options=ALL_DATABASES,
        default=DEFAULT_DATABASES,
        help="选择要搜索的学术数据库（结果会自动合并去重）",
    )

    with st.expander("Agent / 并发设置", expanded=False):
        pipeline_mode = st.radio(
            "流水线模式",
            options=["multi", "single"],
            format_func=lambda x: "多Agent模式 (4个子提取Agent)" if x == "multi" else "单流程模式 (统一提取)",
            index=0,
            help="多Agent模式将提取拆分为GelMA/药物/释放/来源4个子Agent并行提取；单流程模式使用统一prompt一次提取全部字段",
        )
        use_planner = st.toggle(
            "启用 PlannerAgent",
            value=True,
            help="让 LLM 自动分析 query 并选择最优搜索策略（消耗 1 次 LLM 调用）",
        )
        fetch_concurrency = st.slider(
            "下载并发数",
            min_value=1,
            max_value=100,
            value=config.FETCH_CONCURRENCY,
            step=1,
            help="同时下载全文的最大并发数，越高越快但可能触发限速",
        )
        llm_concurrency = st.slider(
            "LLM 提取并发数",
            min_value=1,
            max_value=50,
            value=config.LLM_CONCURRENCY,
            step=1,
            help="同时调用 LLM 提取字段的最大并发数，受 API 限速约束",
        )
        preview_before_extract = st.toggle(
            "提取前预览",
            value=False,
            help="搜索和质量评估后暂停，让你预览论文列表再决定是否继续提取（节省 LLM 费用）",
        )

    with st.expander("Notion 导出", expanded=False):
        notion_enabled = st.toggle(
            "导出到 Notion",
            value=False,
            help="检索完成后自动写入 Notion 数据库（需配置 NOTION_TOKEN 和 NOTION_PARENT_PAGE_ID）",
        )
        if notion_enabled and (not config.NOTION_TOKEN or not config.NOTION_PARENT_PAGE_ID):
            st.warning("请在 .env 中配置 NOTION_TOKEN 和 NOTION_PARENT_PAGE_ID")

    run_btn = st.button("开始检索", type="primary", width="stretch")

    st.divider()

    with st.expander("API 设置"):
        saved_models = load_models()
        model_names = [m["name"] for m in saved_models]

        if saved_models:
            selected = st.selectbox(
                "已保存的模型",
                options=["当前配置"] + model_names,
                index=0,
                key="model_select",
            )
            if selected != "当前配置":
                chosen = next(m for m in saved_models if m["name"] == selected)
                if st.button(f"切换到 {selected}", width="stretch", key="btn_switch"):
                    apply_model(chosen["api_key"], chosen["base_url"], chosen["model"])
                    st.success(f"已切换到 {selected}")
                    st.rerun()

            st.divider()

        st.caption("当前配置")
        api_key = st.text_input(
            "API Key",
            value=config.OPENAI_API_KEY,
            type="password",
            placeholder="sk-...",
        )
        base_url = st.text_input(
            "Base URL",
            value=config.OPENAI_BASE_URL,
            placeholder="https://api.openai.com/v1",
        )
        model = st.text_input(
            "模型名称",
            value=config.OPENAI_MODEL,
            placeholder="gpt-4o-mini",
        )

        col_save, col_add = st.columns(2)
        with col_save:
            if st.button("保存设置", width="stretch", key="btn_save_settings"):
                if not api_key.strip():
                    st.error("API Key 不能为空")
                else:
                    apply_model(api_key.strip(), base_url.strip(), model.strip() or "gpt-4o-mini")
                    st.success("设置已保存")
        with col_add:
            if st.button("存为新模型", width="stretch", key="btn_save_model"):
                st.session_state["show_save_model_form"] = True

        if st.button("检测连接", width="stretch", key="btn_test"):
            key_val = api_key.strip()
            url_val = base_url.strip()
            model_val = model.strip() or "gpt-4o-mini"
            if not key_val:
                st.error("请先填写 API Key")
            else:
                with st.spinner("正在检测..."):
                    ok, msg = test_model_connection(key_val, url_val, model_val)
                if ok:
                    st.success(msg)
                else:
                    st.error(msg)

        if st.session_state.get("show_save_model_form"):
            profile_name = st.text_input("模型配置名称", placeholder="例如: GPT-4o / DeepSeek / 本地模型")
            if st.button("确认保存", width="stretch", key="btn_confirm_save"):
                name = profile_name.strip()
                if not name:
                    st.error("请输入配置名称")
                elif not api_key.strip():
                    st.error("API Key 不能为空")
                else:
                    new_profile = {
                        "name": name,
                        "api_key": api_key.strip(),
                        "base_url": base_url.strip(),
                        "model": model.strip() or "gpt-4o-mini",
                    }
                    models = load_models()
                    models = [m for m in models if m["name"] != name]
                    models.append(new_profile)
                    save_models(models)
                    apply_model(new_profile["api_key"], new_profile["base_url"], new_profile["model"])
                    st.session_state["show_save_model_form"] = False
                    st.success(f"模型「{name}」已保存")
                    st.rerun()

        if saved_models:
            st.divider()
            del_target = st.selectbox(
                "删除已保存的模型",
                options=[""] + model_names,
                index=0,
                format_func=lambda x: "选择要删除的模型..." if x == "" else x,
                key="model_delete",
            )
            if del_target and st.button(f"删除 {del_target}", type="secondary", width="stretch", key="btn_del"):
                models = [m for m in load_models() if m["name"] != del_target]
                save_models(models)
                st.success(f"已删除「{del_target}」")
                st.rerun()

# ── Header ───────────────────────────────────────────────────────────────────

st.title("文献检索助手 V3")
st.caption("Multi-Agent 流水线: Planner -> Search -> Retrieval -> QualityFilter -> Extraction -> Reviewer -> Output")

# ── Tabs ─────────────────────────────────────────────────────────────────────

tab_search, tab_doi, tab_history, tab_stats = st.tabs(["关键词检索", "DOI批量导入", "历史记录", "统计面板"])

# ── Tab 1: Keyword search ────────────────────────────────────────────────────

with tab_search:
    if run_btn:
        if not query.strip():
            st.warning("请输入搜索关键词")
            st.stop()

        if not config.OPENAI_API_KEY:
            st.error("请先在左侧「API 设置」中配置 API Key。")
            st.stop()

        rows = _run_pipeline(
            query.strip(), limit,
            databases=selected_dbs,
            fetch_conc=fetch_concurrency,
            llm_conc=llm_concurrency,
            use_planner=use_planner,
            mode=pipeline_mode,
        )

        if not rows:
            st.info("未提取到任何数据，请尝试调整关键词或增加论文数量。")
        else:
            save_task(query.strip(), rows)
            st.session_state["latest_query"] = query.strip()
            st.session_state["latest_rows"] = rows

            if notion_enabled and config.NOTION_TOKEN and config.NOTION_PARENT_PAGE_ID:
                with st.spinner("正在写入 Notion..."):
                    try:
                        from lit_researcher.notion_writer import write_rows_async
                        count = run_async(write_rows_async(rows))
                        st.success(f"已写入 {count} 条到 Notion")
                    except Exception as e:
                        st.error(f"Notion 写入失败: {e}")

    if st.session_state.get("latest_rows"):
        st.divider()

        from lit_researcher.output import filter_rows_by_quality
        filter_opt = st.radio(
            "显示结果",
            options=["all", "ok", "low_quality"],
            format_func=lambda x: {"all": "全部", "ok": "仅高质量 (ok)", "low_quality": "高+中质量"}[x],
            horizontal=True,
            key="result_filter",
        )
        filtered = filter_rows_by_quality(st.session_state["latest_rows"], min_review=filter_opt)
        _render_results(
            filtered,
            query_label=st.session_state.get("latest_query", ""),
        )

# ── Tab 2: DOI batch import ──────────────────────────────────────────────────

with tab_doi:
    st.subheader("DOI 批量导入")
    st.caption("粘贴 DOI 列表（每行一个，或逗号分隔），也可上传包含 DOI 列的 CSV 文件。")

    doi_text = st.text_area(
        "粘贴 DOI 列表",
        height=150,
        placeholder="10.1234/example.001\n10.5678/example.002\nhttps://doi.org/10.9999/example.003",
    )

    uploaded_csv = st.file_uploader("或上传 CSV 文件（需包含 DOI 列）", type=["csv", "txt"])

    doi_btn = st.button("开始导入并提取", type="primary", width="stretch", key="btn_doi_import")

    if doi_btn:
        if not config.OPENAI_API_KEY:
            st.error("请先在左侧「API 设置」中配置 API Key。")
            st.stop()

        all_dois: list[str] = []

        if doi_text.strip():
            all_dois.extend(parse_doi_list(doi_text))

        if uploaded_csv is not None:
            try:
                csv_df = pd.read_csv(uploaded_csv)
                doi_col = None
                for col in csv_df.columns:
                    if col.lower().strip() in ("doi", "source_doi", "DOI"):
                        doi_col = col
                        break
                if doi_col is None and len(csv_df.columns) == 1:
                    doi_col = csv_df.columns[0]

                if doi_col:
                    csv_dois = csv_df[doi_col].dropna().astype(str).tolist()
                    all_dois.extend(parse_doi_list("\n".join(csv_dois)))
                else:
                    st.warning("CSV 文件中未找到 DOI 列。请确保列名包含 'DOI'。")
            except Exception as e:
                st.error(f"CSV 读取失败: {e}")

        seen = set()
        unique_dois = []
        for d in all_dois:
            key = d.strip().lower()
            if key not in seen:
                seen.add(key)
                unique_dois.append(d)

        if not unique_dois:
            st.warning("未检测到有效的 DOI，请检查输入格式。")
        else:
            st.info(f"检测到 {len(unique_dois)} 个唯一 DOI")
            rows = _run_doi_pipeline(
                unique_dois,
                fetch_conc=fetch_concurrency,
                llm_conc=llm_concurrency,
                mode=pipeline_mode,
            )
            if rows:
                save_task(f"DOI导入({len(unique_dois)}篇)", rows)
                st.session_state["latest_query"] = f"DOI导入({len(unique_dois)}篇)"
                st.session_state["latest_rows"] = rows
                _render_results(rows, query_label=f"DOI导入({len(unique_dois)}篇)")
            else:
                st.info("未提取到任何数据。")

# ── Tab 3: History ───────────────────────────────────────────────────────────

with tab_history:
    st.subheader("历史检索记录")

    history = load_history()
    if not history:
        st.caption("暂无历史记录。检索完成后结果会自动保存在这里。")
    else:
        search_filter = st.text_input("搜索历史记录", placeholder="输入关键词过滤...", key="hist_search")

        if search_filter:
            history = [t for t in history if search_filter.lower() in (t.get("query", "") or "").lower()]

        if st.button("合并所有历史记录（去重导出）", width="stretch", key="btn_merge_all"):
            merged = merge_history_rows(load_history())
            if merged:
                st.session_state["merged_rows"] = merged
                st.success(f"合并完成: {len(merged)} 条唯一记录")
            else:
                st.info("无数据可合并")

        if st.session_state.get("merged_rows"):
            _render_results(st.session_state["merged_rows"], query_label="合并历史")

        for task in history:
            ts = task.get("timestamp", "")
            q = task.get("query", "")
            n = len(task.get("rows", []))
            display_ts = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]} {ts[9:11]}:{ts[11:13]}:{ts[13:15]}" if len(ts) >= 15 else ts

            with st.expander(f"{display_ts}  |  {q}  |  {n} 条结果"):
                task_rows = task.get("rows", [])
                if task_rows:
                    task_df = pd.DataFrame(task_rows)
                    display_cols = [f for f in ALL_COLUMNS if f in task_df.columns]
                    task_df = task_df[display_cols]
                    st.dataframe(
                        _sanitize_df_for_arrow(task_df.rename(columns={**FIELD_LABELS, **ALL_CN})),
                        width="stretch",
                        hide_index=True,
                    )

                    col_dl1, col_dl2, col_del = st.columns([2, 2, 1])
                    with col_dl1:
                        st.download_button(
                            label="下载 CSV",
                            data=df_to_csv_bytes(task_df),
                            file_name=f"results_{ts}.csv",
                            mime="text/csv",
                            width="stretch",
                            key=f"hist_csv_{ts}",
                        )
                    with col_dl2:
                        st.download_button(
                            label="下载 Excel",
                            data=df_to_excel_bytes(task_rows),
                            file_name=f"results_{ts}.xlsx",
                            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            width="stretch",
                            key=f"hist_xlsx_{ts}",
                        )
                    with col_del:
                        if st.button("删除", type="secondary", width="stretch", key=f"hist_del_{ts}"):
                            delete_task(ts)
                            if st.session_state.get("latest_query") == q:
                                st.session_state.pop("latest_rows", None)
                                st.session_state.pop("latest_query", None)
                            st.rerun()
                else:
                    st.caption("该记录无数据")

# ── Tab 4: Stats ─────────────────────────────────────────────────────────────

with tab_stats:
    st.subheader("统计面板")

    all_history = load_history()
    if not all_history:
        st.caption("暂无数据。完成检索后这里会显示统计信息。")
    else:
        stats = history_stats(all_history)

        col_a, col_b, col_c = st.columns(3)
        col_a.metric("总检索次数", stats["total_tasks"])
        col_b.metric("总论文数", stats["total_papers"])
        col_c.metric("平均数据质量", f"{stats['avg_quality']:.0%}")

        st.divider()

        st.subheader("文本来源分布")
        source_counts = stats["source_counts"]
        if source_counts:
            source_df = pd.DataFrame(
                [{"来源": k, "数量": v} for k, v in sorted(source_counts.items(), key=lambda x: -x[1])]
            )
            st.bar_chart(source_df, x="来源", y="数量")
        else:
            st.caption("暂无来源数据")

        st.divider()

        st.subheader("数据质量分布")
        all_rows = [r for t in all_history for r in t.get("rows", [])]
        qualities = [r.get("_data_quality", 0) for r in all_rows if r.get("_data_quality") is not None]
        if qualities:
            q_df = pd.DataFrame({"数据质量": qualities})
            st.bar_chart(q_df["数据质量"].value_counts().sort_index())
        else:
            st.caption("暂无质量数据")
