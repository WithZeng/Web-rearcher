"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronDown, Search, Loader2, Database } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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

  const { query, limit, selectedDbs, mode, usePlanner, fetchConcurrency, llmConcurrency } = searchParams;

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const wsCloseRef = useRef<(() => void) | null>(null);
  const reconnectedRef = useRef(false);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      if (selectedDbs.length === 0) {
        setSearchParam("selectedDbs", m.default_databases);
      }
    });
  }, [setMeta, selectedDbs.length, setSearchParam]);

  useEffect(() => {
    if (reconnectedRef.current) return;
    const taskId = pipeline.taskId;
    const alreadyDone = pipeline.currentStage === 'done' || pipeline.currentStage === 'error';
    if (!taskId || pipeline.running || alreadyDone) return;

    reconnectedRef.current = true;
    api.pipeline.status(taskId).then((s) => {
      if (!s.done && !s.error) {
        setPipelineField("running", true);
        wsCloseRef.current?.();
        const { close } = connectPipeline(taskId, handlePipelineMessage, () => {
          wsCloseRef.current = null;
        });
        wsCloseRef.current = close;
      }
    }).catch(() => {});
  }, [pipeline.taskId, pipeline.running, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

  useEffect(() => {
    return () => {
      wsCloseRef.current?.();
    };
  }, []);

  const toggleDb = useCallback((db: string) => {
    setSearchParam("selectedDbs",
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
        databases: selectedDbs,
        mode: mode === "multi" ? "multi_agent" : "single",
        use_planner: usePlanner,
        fetch_concurrency: fetchConcurrency,
        llm_concurrency: llmConcurrency,
      });

      setPipelineField("running", true);
      setPipelineField("taskId", task_id);
      setPipelineField("progress", 0);
      setPipelineField("startedAt", Date.now());

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

  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Notion push
  const [notionDialogOpen, setNotionDialogOpen] = useState(false);
  const [notionPushing, setNotionPushing] = useState(false);
  const [notionResult, setNotionResult] = useState<NotionPushResult | null>(null);

  const notionStats = useCallback(() => {
    const rows = pipeline.rows;
    const invalid = rows.filter((r) => {
      const q = Number(r._data_quality);
      if (q === 0 || isNaN(q)) return true;
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
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      {/* Search bar */}
      <div className="flex items-center gap-3">
        <Input
          className="h-12 flex-1 text-lg"
          placeholder="输入检索关键词..."
          value={query}
          onChange={(e) => setSearchParam("query", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <Input
          type="number"
          className="h-12 w-20 text-center"
          min={1}
          max={500}
          value={limit}
          onChange={(e) => setSearchParam("limit", Number(e.target.value) || 1)}
        />
        <Button
          className="h-12 gap-2 px-6"
          disabled={!query.trim() || pipeline.running}
          onClick={handleSearch}
        >
          {pipeline.running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          开始检索
        </Button>
      </div>

      {/* Recommended queries */}
      {meta?.recommended_queries && meta.recommended_queries.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {meta.recommended_queries.slice(0, 5).map((q) => (
            <button
              key={q}
              onClick={() => setSearchParam("query", q)}
              className="cursor-pointer rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-blue-500/50 hover:bg-zinc-700 hover:text-blue-400"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Database selector */}
      {meta?.all_databases && meta.all_databases.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-zinc-400">数据库</p>
          <div className="flex flex-wrap gap-2">
            {meta.all_databases.map((db) => {
              const active = selectedDbs.includes(db);
              return (
                <Badge
                  key={db}
                  variant={active ? "default" : "outline"}
                  className={`cursor-pointer select-none transition-colors ${
                    active
                      ? ""
                      : "text-zinc-400 hover:border-zinc-500 hover:text-zinc-300"
                  }`}
                  onClick={() => toggleDb(db)}
                >
                  {db}
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {/* Advanced settings */}
      <div>
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <motion.span
            animate={{ rotate: advancedOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="inline-flex"
          >
            <ChevronDown className="size-3.5" />
          </motion.span>
          高级设置
        </button>

        <AnimatePresence initial={false}>
          {advancedOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                {/* Pipeline mode */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-zinc-400">流水线模式</p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={mode === "multi" ? "default" : "outline"}
                      onClick={() => setSearchParam("mode", "multi")}
                    >
                      多Agent
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

                {/* Planner toggle */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-zinc-400">规划器</p>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={usePlanner}
                      onCheckedChange={(v) => setSearchParam("usePlanner", v)}
                    />
                    <span className="text-sm text-zinc-300">
                      {usePlanner ? "启用" : "禁用"}
                    </span>
                  </div>
                </div>

                {/* Fetch concurrency */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-zinc-400">
                      抓取并发
                    </p>
                    <span className="text-xs tabular-nums text-zinc-500">
                      {fetchConcurrency}
                    </span>
                  </div>
                  <Slider
                    min={1}
                    max={50}
                    step={1}
                    value={[fetchConcurrency]}
                    onValueChange={(v) => setSearchParam("fetchConcurrency", Array.isArray(v) ? v[0] : v)}
                  />
                  <p className="text-[10px] text-zinc-600">推荐 10-20，过高易触发网站限流</p>
                </div>

                {/* LLM concurrency */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-zinc-400">
                      LLM 并发
                    </p>
                    <span className="text-xs tabular-nums text-zinc-500">
                      {llmConcurrency}
                    </span>
                  </div>
                  <Slider
                    min={1}
                    max={20}
                    step={1}
                    value={[llmConcurrency]}
                    onValueChange={(v) => setSearchParam("llmConcurrency", Array.isArray(v) ? v[0] : v)}
                  />
                  <p className="text-[10px] text-zinc-600">推荐 3-8，取决于 API 速率限制</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Separator className="bg-zinc-800" />

      {/* Pipeline progress */}
      {showProgress && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <PipelineProgress />
        </motion.div>
      )}

      {/* Error */}
      {pipeline.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {pipeline.error}
        </div>
      )}

      {/* Results */}
      {pipeline.rows.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">
              提取结果
            </h2>
            <div className="flex items-center gap-2">
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
        </motion.div>
      )}

      <PaperDetail
        paper={selectedPaper}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />

      {/* Notion Push Dialog */}
      <Dialog
        open={notionDialogOpen}
        onOpenChange={setNotionDialogOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>推送到 Notion</DialogTitle>
            <DialogDescription>
              将检索结果推送到 Notion 数据库
            </DialogDescription>
          </DialogHeader>

          {notionResult ? (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2 py-2 text-sm"
            >
              <p className="text-green-400">
                成功推送 {notionResult.pushed} 条，过滤 {notionResult.skipped_quality} 条无效，跳过 {notionResult.skipped_duplicate} 条重复
              </p>
              <p className="text-xs text-zinc-500">
                共处理 {notionResult.total} 条
              </p>
            </motion.div>
          ) : (
            <div className="space-y-2 py-2 text-sm text-zinc-300">
              <p>
                共 <span className="font-medium text-zinc-100">{notionStats().total}</span> 条结果
              </p>
              <p className="text-xs text-zinc-500">
                其中 {notionStats().invalid} 条可能因质量为 0 或缺少核心字段被过滤
              </p>
            </div>
          )}

          <DialogFooter>
            {notionResult ? (
              <Button
                variant="outline"
                onClick={() => setNotionDialogOpen(false)}
              >
                关闭
              </Button>
            ) : (
              <Button
                onClick={handleNotionPush}
                disabled={notionPushing}
              >
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
