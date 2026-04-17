"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronDown, Database, Loader2, Search, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api, type NotionPushResult } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { useAppStore } from "@/lib/store";

export default function SearchPage() {
  const meta = useAppStore((s) => s.meta);
  const setMeta = useAppStore((s) => s.setMeta);
  const pipeline = useAppStore((s) => s.pipeline);
  const setPipelineField = useAppStore((s) => s.setPipelineField);
  const resetPipeline = useAppStore((s) => s.resetPipeline);
  const handlePipelineMessage = useAppStore((s) => s.handlePipelineMessage);

  const searchParams = useAppStore((s) => s.searchParams);
  const setSearchParam = useAppStore((s) => s.setSearchParam);

  const { query, limit, targetPassedCount, selectedDbs, mode, usePlanner, fetchConcurrency, llmConcurrency } = searchParams;

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notionDialogOpen, setNotionDialogOpen] = useState(false);
  const [notionPushing, setNotionPushing] = useState(false);
  const [notionResult, setNotionResult] = useState<NotionPushResult | null>(null);

  const wsCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      if (selectedDbs.length === 0) {
        setSearchParam("selectedDbs", m.default_databases);
      }
    });
  }, [setMeta, selectedDbs.length, setSearchParam]);

  useEffect(() => {
    const taskId = pipeline.taskId;
    const alreadyDone = pipeline.currentStage === "done" || pipeline.currentStage === "error";
    if (!taskId || alreadyDone) return;

    let cancelled = false;

    const syncTaskStatus = async () => {
      try {
        const status = await api.pipeline.status(taskId);
        if (cancelled) return;

        if (status.error) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "error", message: status.error });
          return;
        }

        if (status.done) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "complete" });
          return;
        }

        if (!wsCloseRef.current) {
          setPipelineField("running", true);
          const { close } = connectPipeline(taskId, handlePipelineMessage, () => {
            wsCloseRef.current = null;
          });
          wsCloseRef.current = close;
        }
      } catch {
        // Keep polling so transient network issues do not leave the UI stuck forever.
      }
    };

    void syncTaskStatus();
    const timer = window.setInterval(() => {
      void syncTaskStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pipeline.taskId, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

  useEffect(() => {
    return () => {
      wsCloseRef.current?.();
    };
  }, []);

  const toggleDb = useCallback((db: string) => {
    setSearchParam(
      "selectedDbs",
      selectedDbs.includes(db)
        ? selectedDbs.filter((d) => d !== db)
        : [...selectedDbs, db],
    );
  }, [selectedDbs, setSearchParam]);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || pipeline.running) return;

    resetPipeline();

    try {
      const { task_id } = await api.pipeline.run({
        query: query.trim(),
        limit,
        target_passed_count: targetPassedCount ?? undefined,
        databases: selectedDbs,
        mode,
        use_planner: usePlanner,
        fetch_concurrency: fetchConcurrency,
        llm_concurrency: llmConcurrency,
      });

      setPipelineField("running", true);
      setPipelineField("taskId", task_id);
      setPipelineField("progress", 0);
      setPipelineField("startedAt", Date.now());
      setPipelineField("currentStage", "");
      setPipelineField("error", null);

      wsCloseRef.current?.();
      const { close } = connectPipeline(task_id, handlePipelineMessage, () => {
        wsCloseRef.current = null;
      });
      wsCloseRef.current = close;
    } catch (err) {
      setPipelineField("error", err instanceof Error ? err.message : "请求失败");
    }
  }, [
    query,
    limit,
    targetPassedCount,
    selectedDbs,
    mode,
    usePlanner,
    fetchConcurrency,
    llmConcurrency,
    pipeline.running,
    resetPipeline,
    setPipelineField,
    handlePipelineMessage,
  ]);

  const notionStats = useCallback(() => {
    const rows = pipeline.rows;
    const invalid = rows.filter((r) => {
      const q = Number(r._data_quality);
      if (q === 0 || Number.isNaN(q)) return true;
      if (!r.source_title && !r.doi) return true;
      return false;
    }).length;
    return { total: rows.length, invalid };
  }, [pipeline.rows]);

  const handleNotionPush = useCallback(async () => {
    setNotionPushing(true);
    setNotionResult(null);
    try {
      const result = await api.notion.pushStream(pipeline.rows, () => {});
      setNotionResult(result);
    } catch (err) {
      console.error("Notion push failed:", err);
    } finally {
      setNotionPushing(false);
    }
  }, [pipeline.rows]);

  const showProgress = pipeline.running || pipeline.rows.length > 0;

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <p className="page-kicker">文献检索</p>
            <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-white md:text-5xl">
              输入关键词，开始文献检索与提取。
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              支持按主题、药物、机制或疾病进行检索，并在结果中继续完成筛选、提取和复核。
            </p>

            <div className="mt-7 flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  className="h-14 rounded-full border-white/10 bg-black/20 pl-11 pr-4 text-base text-zinc-100 placeholder:text-zinc-600"
                  placeholder="例如：glioblastoma temozolomide resistance"
                  value={query}
                  onChange={(e) => setSearchParam("query", e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
              </div>

              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  className="h-14 w-24 rounded-full border-white/10 bg-black/20 text-center text-base text-zinc-100"
                  min={1}
                  max={20000}
                  value={limit}
                  onChange={(e) => setSearchParam("limit", Number(e.target.value) || 1)}
                />
                <Button
                  className="h-14 rounded-full bg-cyan-400 px-6 text-slate-950 hover:bg-cyan-300"
                  disabled={!query.trim() || pipeline.running}
                  onClick={handleSearch}
                >
                  {pipeline.running ? (
                    <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
                  ) : (
                    <Search className="size-4" data-icon="inline-start" />
                  )}
                  开始检索
                </Button>
              </div>
            </div>

            {meta?.recommended_queries && meta.recommended_queries.length > 0 ? (
              <div className="mt-6 flex flex-wrap gap-2">
                {meta.recommended_queries.slice(0, 5).map((q) => (
                  <button
                    key={q}
                    onClick={() => setSearchParam("query", q)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-zinc-300 transition hover:border-cyan-300/20 hover:bg-cyan-400/10 hover:text-cyan-100"
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "数据源", value: String(selectedDbs.length), hint: "已选数据库" },
              { label: "模式", value: mode === "multi" ? "Multi" : "Single", hint: "执行策略" },
              { label: "规划器", value: usePlanner ? "On" : "Off", hint: "查询拆解" },
            ].map((item) => (
              <div key={item.label} className="rounded-[24px] border border-white/10 bg-black/20 p-5">
                <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{item.label}</p>
                <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{item.value}</p>
                <p className="mt-2 text-sm text-zinc-500">{item.hint}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="panel p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="page-kicker">数据源</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">选择检索数据库</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                选择这次要检索的数据源，支持多选。
              </p>
            </div>
            <Badge className="border-cyan-400/20 bg-cyan-400/10 text-cyan-200">
              {selectedDbs.length} 个已启用
            </Badge>
          </div>

          {meta?.all_databases && meta.all_databases.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {meta.all_databases.map((db) => {
                const active = selectedDbs.includes(db);
                return (
                  <Badge
                    key={db}
                    variant={active ? "default" : "outline"}
                    className={`cursor-pointer rounded-full px-4 py-2 transition ${
                      active
                        ? "border-cyan-400/15 bg-cyan-400/10 text-cyan-100"
                        : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                    }`}
                    onClick={() => toggleDb(db)}
                  >
                    {db}
                  </Badge>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="panel p-5 md:p-6">
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-3"
          >
            <div className="text-left">
              <p className="page-kicker">高级设置</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">调整检索参数</h2>
            </div>
            <motion.span
              animate={{ rotate: advancedOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="inline-flex rounded-full border border-white/10 bg-white/[0.04] p-2 text-zinc-400"
            >
              <ChevronDown className="size-4" />
            </motion.span>
          </button>

          <AnimatePresence initial={false}>
            {advancedOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.24, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="mt-5 space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="panel-muted p-4">
                      <p className="text-xs font-medium text-zinc-400">流水线模式</p>
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant={mode === "multi" ? "default" : "outline"}
                          onClick={() => setSearchParam("mode", "multi")}
                        >
                          多 Agent
                        </Button>
                        <Button
                          size="sm"
                          variant={mode === "single" ? "default" : "outline"}
                          onClick={() => setSearchParam("mode", "single")}
                        >
                          单流程
                        </Button>
                      </div>
                    </div>

                    <div className="panel-muted p-4">
                      <p className="text-xs font-medium text-zinc-400">查询规划器</p>
                      <div className="mt-3 flex items-center gap-3">
                        <Switch
                          checked={usePlanner}
                          onCheckedChange={(v) => setSearchParam("usePlanner", v)}
                        />
                        <span className="text-sm text-zinc-300">
                          {usePlanner ? "已启用" : "已关闭"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="panel-muted p-4">
                      <p className="text-xs font-medium text-zinc-400">Target Passed Count</p>
                      <Input
                        type="number"
                        min={1}
                        placeholder="Leave empty for single-round mode"
                        value={targetPassedCount ?? ""}
                        onChange={(e) => {
                          const value = e.target.value.trim();
                          setSearchParam("targetPassedCount", value ? Math.max(1, Number(value) || 1) : null);
                        }}
                        className="mt-3 h-11 rounded-2xl border-white/10 bg-black/20 text-zinc-100"
                      />
                      <p className="mt-3 text-xs leading-5 text-zinc-500">
                        When set, the keyword search keeps rolling until quality-filter passed papers reach this target.
                      </p>
                    </div>

                    <div className="panel-muted p-4">
                      <p className="text-xs font-medium text-zinc-400">Max Unique Candidates</p>
                      <Input
                        type="number"
                        min={1}
                        max={20000}
                        value={limit}
                        onChange={(e) => setSearchParam("limit", Math.max(1, Number(e.target.value) || 1))}
                        className="mt-3 h-11 rounded-2xl border-white/10 bg-black/20 text-zinc-100"
                      />
                      <p className="mt-3 text-xs leading-5 text-zinc-500">
                        In rolling mode, limit becomes the deduplicated candidate cap before the pipeline stops.
                      </p>
                    </div>
                  </div>

                  <div className="panel-muted p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-zinc-300">抓取并发</p>
                      <span className="text-xs tabular-nums text-zinc-500">{fetchConcurrency}</span>
                    </div>
                    <Slider
                      className="mt-4"
                      min={1}
                      max={50}
                      step={1}
                      value={[fetchConcurrency]}
                      onValueChange={(v) => setSearchParam("fetchConcurrency", Array.isArray(v) ? v[0] : v)}
                    />
                    <p className="mt-3 text-xs leading-5 text-zinc-500">
                      推荐 10-20，过高可能触发目标站点限流。
                    </p>
                  </div>

                  <div className="panel-muted p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-zinc-300">LLM 并发</p>
                      <span className="text-xs tabular-nums text-zinc-500">{llmConcurrency}</span>
                    </div>
                    <Slider
                      className="mt-4"
                      min={1}
                      max={20}
                      step={1}
                      value={[llmConcurrency]}
                      onValueChange={(v) => setSearchParam("llmConcurrency", Array.isArray(v) ? v[0] : v)}
                    />
                    <p className="mt-3 text-xs leading-5 text-zinc-500">
                      推荐 3-8，取决于模型接口的速率限制。
                    </p>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </section>

      <Separator className="bg-white/8" />

      {pipeline.taskId ? (
        <div className="flex justify-end">
          <Link href={`/tasks?task=${encodeURIComponent(pipeline.taskId)}`}>
            <Button variant="outline" size="sm">
              <Sparkles className="size-3.5" data-icon="inline-start" />
              在任务中心查看
            </Button>
          </Link>
        </div>
      ) : null}

      {showProgress ? <PipelineProgress /> : null}

      {pipeline.error ? (
        <div className="rounded-[24px] border border-red-500/20 bg-red-500/10 px-5 py-4 text-sm text-red-300">
          {pipeline.error}
        </div>
      ) : null}

      {pipeline.rows.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">结果</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">检索结果</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                可以在这里查看明细、导出结果，或推送到 Notion。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNotionResult(null);
                  setNotionDialogOpen(true);
                }}
              >
                <Database className="size-3.5" data-icon="inline-start" />
                推送到 Notion
              </Button>
              <ExportMenu rows={pipeline.rows} />
            </div>
          </div>

          <ResultsTable
            rows={pipeline.rows}
            onRowClick={(row) => {
              setSelectedPaper(row);
              setDetailOpen(true);
            }}
          />
        </section>
      ) : null}

      <PaperDetail paper={selectedPaper} open={detailOpen} onClose={() => setDetailOpen(false)} />

      <Dialog open={notionDialogOpen} onOpenChange={setNotionDialogOpen}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">推送到 Notion</DialogTitle>
            <DialogDescription className="text-zinc-400">
              将当前检索结果写入 Notion 数据库。
            </DialogDescription>
          </DialogHeader>

          {notionResult ? (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-[22px] border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm"
            >
              <p className="font-medium text-emerald-300">
                成功推送 {notionResult.pushed} 条，过滤 {notionResult.skipped_quality} 条低质量记录，跳过 {notionResult.skipped_duplicate} 条重复记录。
              </p>
              <p className="mt-2 text-xs text-emerald-100/75">
                共处理 {notionResult.total} 条。
              </p>
            </motion.div>
          ) : (
            <div className="space-y-3 rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
              <div className="flex items-center gap-2 text-cyan-200">
                <Sparkles className="size-4" />
                <span>系统会自动跳过重复或低质量结果。</span>
              </div>
              <p>
                共 <span className="font-semibold text-white">{notionStats().total}</span> 条结果
              </p>
              <p className="text-xs text-zinc-500">
                其中 {notionStats().invalid} 条可能因质量为 0 或缺少关键字段而被过滤。
              </p>
            </div>
          )}

          <DialogFooter>
            {notionResult ? (
              <Button variant="outline" onClick={() => setNotionDialogOpen(false)}>
                关闭
              </Button>
            ) : (
              <Button onClick={handleNotionPush} disabled={notionPushing}>
                {notionPushing ? (
                  <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                ) : (
                  <Database className="size-3.5" data-icon="inline-start" />
                )}
                确认推送
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
