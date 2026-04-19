"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  Merge,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api, type HistoryTask, type NotionPushProgress, type PubchemProgress } from "@/lib/api";

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderCount(value?: number) {
  return value != null ? `${value} 篇` : "--";
}

export default function HistoryPage() {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expandedTs, setExpandedTs] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [mergedRows, setMergedRows] = useState<Record<string, unknown>[] | null>(null);
  const [mergeStats, setMergeStats] = useState<{
    totalBefore: number;
    removed: number;
    dedupDiscarded: number;
    pushedCount: number;
    unpushedCount: number;
    coreGateCount: number;
    candidateOnlyCount: number;
  } | null>(null);
  const [pushedTab, setPushedTab] = useState<"all" | "unpushed" | "pushed">("unpushed");
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [cleanupDialog, setCleanupDialog] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ removed: number; rows_after: number } | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<{
    scope_count: number;
    rows_after: number;
    removed: number;
    breakdown: Record<string, number>;
    pushed_filter: string;
  } | null>(null);
  const [cleanupPreviewBusy, setCleanupPreviewBusy] = useState(false);
  const [notionBusy, setNotionBusy] = useState(false);
  const [notionDialog, setNotionDialog] = useState(false);
  const [notionResult, setNotionResult] = useState<{
    pushed: number;
    patched: number;
    skipped_quality: number;
    skipped_duplicate: number;
    total: number;
  } | null>(null);
  const [notionError, setNotionError] = useState<string | null>(null);
  const [notionProgress, setNotionProgress] = useState<NotionPushProgress | null>(null);
  const [notionPatchExisting, setNotionPatchExisting] = useState(false);
  const [pubchemBusy, setPubchemBusy] = useState(false);
  const [pubchemResult, setPubchemResult] = useState<{
    enriched_papers: number;
    fields_filled: number;
    unique_drugs: number;
    resolved_drugs: number;
    unresolved_drugs: number;
  } | null>(null);
  const [pubchemDialog, setPubchemDialog] = useState(false);
  const [pubchemForce, setPubchemForce] = useState(true);
  const [pubchemProgress, setPubchemProgress] = useState<PubchemProgress | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.history.list();
      setTasks(data);
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return tasks;
    const q = filter.toLowerCase();
    return tasks.filter((t) => t.query.toLowerCase().includes(q));
  }, [tasks, filter]);

  const toggleExpand = useCallback((ts: string) => {
    setExpandedTs((prev) => {
      const next = new Set(prev);
      if (next.has(ts)) next.delete(ts);
      else next.add(ts);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.history.delete(deleteTarget);
      setTasks((prev) => prev.filter((t) => t.timestamp !== deleteTarget));
      setExpandedTs((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget);
        return next;
      });
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  const loadMerged = useCallback(async (tab: "all" | "unpushed" | "pushed" = pushedTab) => {
    try {
      const result = await api.history.merge(0, true, tab);
      setMergedRows(result.rows);
      setMergeStats({
        totalBefore: result.total_before,
        removed: result.removed,
        dedupDiscarded: result.dedup_discarded ?? 0,
        pushedCount: result.pushed_count,
        unpushedCount: result.unpushed_count,
        coreGateCount: result.core_gate_count ?? 0,
        candidateOnlyCount: result.candidate_only_count ?? 0,
      });
    } catch (err) {
      console.error("Merge failed:", err);
    }
  }, [pushedTab]);

  const handleMerge = useCallback(() => loadMerged(), [loadMerged]);

  const handleTabChange = useCallback((tab: "all" | "unpushed" | "pushed") => {
    setPushedTab(tab);
    loadMerged(tab);
  }, [loadMerged]);

  const handleCleanup = useCallback(async () => {
    setCleanupBusy(true);
    try {
      const result = await api.history.cleanup(0, pushedTab);
      setCleanupResult({ removed: result.removed, rows_after: result.rows_after });
      if (result.removed > 0) {
        fetchHistory();
        await loadMerged(pushedTab);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    } finally {
      setCleanupBusy(false);
    }
  }, [fetchHistory, loadMerged, pushedTab]);

  const openCleanupDialog = useCallback(async () => {
    setCleanupResult(null);
    setCleanupDialog(true);
    setCleanupPreviewBusy(true);
    try {
      const result = await api.history.cleanupPreview(0, pushedTab);
      setCleanupPreview(result);
    } catch (err) {
      console.error("Cleanup preview failed:", err);
      setCleanupPreview(null);
    } finally {
      setCleanupPreviewBusy(false);
    }
  }, [pushedTab]);

  const handlePubchemEnrich = useCallback(async () => {
    setPubchemBusy(true);
    setPubchemResult(null);
    setPubchemProgress(null);
    try {
      const result = await api.history.enrichPubchem(pubchemForce, (progress) => {
        if (progress.phase !== "heartbeat") {
          setPubchemProgress(progress);
        }
      });
      setPubchemResult(result);
      if (result.enriched_papers > 0) {
        fetchHistory();
        if (mergedRows) await loadMerged(pushedTab);
      }
    } catch (err) {
      console.error("PubChem enrichment failed:", err);
    } finally {
      setPubchemBusy(false);
      setPubchemProgress(null);
    }
  }, [fetchHistory, mergedRows, loadMerged, pushedTab, pubchemForce]);

  const handleNotionPush = useCallback(async () => {
    if (!mergedRows?.length) return;
    setNotionBusy(true);
    setNotionError(null);
    setNotionResult(null);
    setNotionProgress(null);
    try {
      const result = await api.notion.pushStream(
        mergedRows,
        (progress) => setNotionProgress(progress),
        notionPatchExisting,
      );
      setNotionResult(result);
      if (result.pushed > 0 || result.patched > 0 || result.skipped_duplicate > 0) {
        await loadMerged(pushedTab);
      }
    } catch (err) {
      setNotionError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotionBusy(false);
      setNotionProgress(null);
    }
  }, [mergedRows, loadMerged, notionPatchExisting, pushedTab]);

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <p className="page-kicker">历史记录</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              查看历史任务，并继续处理已有结果。
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              支持合并去重、清理无效数据、PubChem 补全和推送 Notion。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "历史任务", value: String(tasks.length), hint: "累计记录" },
              { label: "当前筛选", value: filter.trim() ? "已启用" : "全部", hint: filter || "无关键词" },
              { label: "合并结果", value: mergedRows ? String(mergedRows.length) : "--", hint: "当前视图" },
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

      <section className="panel p-5 md:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative max-w-xl flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索历史查询..."
              className="h-12 rounded-full border-white/10 bg-black/20 pl-10 text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleMerge}>
              <Merge className="size-3.5" data-icon="inline-start" />
              合并去重
            </Button>
            <Button
              variant="outline"
              disabled={pubchemBusy}
              onClick={() => {
                setPubchemResult(null);
                setPubchemDialog(true);
              }}
            >
              {pubchemBusy ? (
                <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
              ) : (
                <FlaskConical className="size-3.5" data-icon="inline-start" />
              )}
              PubChem 补全
            </Button>
            <Button
              variant="outline"
              className="border-red-500/20 text-red-300 hover:bg-red-500/10 hover:text-red-200"
              onClick={() => void openCleanupDialog()}
            >
              <Sparkles className="size-3.5" data-icon="inline-start" />
              清理无效数据
            </Button>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {mergedRows ? (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-4 overflow-hidden"
          >
            <div className="panel p-5 md:p-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="page-kicker">合并结果</p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">去重后的数据</h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">
                    当前共 {mergedRows.length} 条记录
                    {mergeStats?.dedupDiscarded ? `，去重时额外丢弃 ${mergeStats.dedupDiscarded} 条不完整记录。` : "。"}
                  </p>
                  {mergeStats ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                        已推送 <span className="ml-1 font-semibold text-zinc-100">{mergeStats.pushedCount}</span>
                      </span>
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                        未推送 <span className="ml-1 font-semibold text-zinc-100">{mergeStats.unpushedCount}</span>
                      </span>
                      <span className="rounded-full border border-emerald-400/15 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                        符合核心实验门槛 <span className="ml-1 font-semibold">{mergeStats.coreGateCount}</span>
                      </span>
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                        仅候选保留 <span className="ml-1 font-semibold text-zinc-100">{mergeStats.candidateOnlyCount}</span>
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pubchemBusy}
                    onClick={() => {
                      setPubchemResult(null);
                      setPubchemDialog(true);
                    }}
                  >
                    {pubchemBusy ? (
                      <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                    ) : (
                      <FlaskConical className="size-3.5" data-icon="inline-start" />
                    )}
                    PubChem 补全
                  </Button>
                  {mergedRows.length > 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={notionBusy}
                      onClick={() => {
                        setNotionResult(null);
                        setNotionError(null);
                        setNotionDialog(true);
                      }}
                    >
                      {notionBusy ? (
                        <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                      ) : (
                        <Upload className="size-3.5" data-icon="inline-start" />
                      )}
                      推送到 Notion
                    </Button>
                  ) : null}
                  <ExportMenu rows={mergedRows} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMergedRows(null);
                      setMergeStats(null);
                    }}
                  >
                    关闭
                  </Button>
                </div>
              </div>

              <div className="mt-5 flex w-fit items-center gap-1 rounded-full border border-white/8 bg-white/[0.03] p-1">
                {[
                  { key: "unpushed" as const, label: "未推送", count: mergeStats?.unpushedCount },
                  { key: "pushed" as const, label: "已推送", count: mergeStats?.pushedCount },
                  { key: "all" as const, label: "全部", count: mergeStats?.totalBefore },
                ].map(({ key, label, count }) => (
                  <button
                    key={key}
                    onClick={() => handleTabChange(key)}
                    className={`rounded-full px-4 py-2 text-xs font-medium transition ${
                      pushedTab === key
                        ? "bg-cyan-400/10 text-cyan-100"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {label}
                    {count != null ? <span className="ml-1.5 text-zinc-500">{count}</span> : null}
                  </button>
                ))}
              </div>
            </div>

            <ResultsTable rows={mergedRows} onRowClick={(row) => setSelectedPaper(row)} />
            <Separator className="bg-white/8" />
          </motion.section>
        ) : null}
      </AnimatePresence>

      {loading ? (
        <div className="panel flex h-56 items-center justify-center text-sm text-zinc-500">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="panel flex h-56 items-center justify-center text-sm text-zinc-500">暂无历史记录</div>
      ) : (
        <section className="panel p-3 md:p-4">
          <div className="space-y-2">
            {filtered.map((task) => {
              const expanded = expandedTs.has(task.timestamp);
              return (
                <div key={task.timestamp} className="rounded-[24px] border border-white/8 bg-white/[0.02]">
                  <button
                    onClick={() => toggleExpand(task.timestamp)}
                    className="flex w-full items-center gap-3 px-4 py-4 text-left transition hover:bg-white/[0.02]"
                  >
                    {expanded ? (
                      <ChevronDown className="size-4 shrink-0 text-zinc-500" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-zinc-500" />
                    )}
                    <span className="shrink-0 font-mono text-xs text-zinc-600">{formatTimestamp(task.timestamp)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{task.query}</span>
                    {task.search_metadata?.databases && task.search_metadata.databases.length > 0 ? (
                      <span className="hidden shrink-0 text-[10px] text-zinc-600 sm:inline">
                        {task.search_metadata.databases.join(", ")}
                      </span>
                    ) : null}
                    <Badge variant="secondary" className="shrink-0">
                      {task.count} 篇
                    </Badge>
                  </button>

                  <AnimatePresence>
                    {expanded ? (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-3 px-4 pb-4 pt-1">
                          {task.search_metadata?.raw_hit_count != null || task.search_metadata?.deduped_count != null ? (
                            <div className="rounded-[18px] border border-white/8 bg-white/[0.02] px-4 py-3 text-sm text-zinc-300">
                              <div className="flex flex-wrap gap-4">
                                <span>原始命中：<span className="font-medium text-white">{renderCount(task.search_metadata?.raw_hit_count)}</span></span>
                                <span>去重后：<span className="font-medium text-white">{renderCount(task.search_metadata?.deduped_count)}</span></span>
                                <span>最终结果：<span className="font-medium text-white">{task.count} 篇</span></span>
                              </div>
                            </div>
                          ) : null}
                          <div className="flex items-center justify-end gap-2">
                            <ExportMenu rows={task.rows} />
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(task.timestamp);
                              }}
                            >
                              <Trash2 className="size-3.5" data-icon="inline-start" />
                              删除
                            </Button>
                          </div>
                          <ResultsTable rows={task.rows} onRowClick={(row) => setSelectedPaper(row)} />
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))]">
          <DialogHeader>
            <DialogTitle className="text-white">确认删除</DialogTitle>
            <DialogDescription className="text-zinc-400">
              此操作会永久删除这条历史记录，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cleanupDialog} onOpenChange={(o) => !o && setCleanupDialog(false)}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))]">
          <DialogHeader>
            <DialogTitle className="text-white">清理无效数据</DialogTitle>
            <DialogDescription className="text-zinc-400">
              将按你当前查看的合并结果口径永久移除无效数据，不再默认扫描全部历史数据。
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-4 text-sm text-zinc-400">
            <li>当前作用范围：{pushedTab === "unpushed" ? "未推送" : pushedTab === "pushed" ? "已推送" : "全部"} 合并结果</li>
            <li>数据质量低于 15% 的记录</li>
            <li>缺少药物名称 `drug_name` 的记录</li>
            <li>核心字段不足 2 个的记录</li>
          </ul>
          {cleanupPreviewBusy ? (
            <div className="rounded-[20px] border border-white/8 bg-white/[0.03] p-3 text-sm text-zinc-400">
              正在计算清理预览...
            </div>
          ) : cleanupPreview ? (
            <div className="rounded-[20px] border border-white/8 bg-white/[0.03] p-3 text-sm text-zinc-300">
              <p>当前视图共 {cleanupPreview.scope_count} 条，预计清理 {cleanupPreview.removed} 条，保留 {cleanupPreview.rows_after} 条。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                  低质量 {cleanupPreview.breakdown.low_quality ?? 0}
                </span>
                <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                  缺药名 {cleanupPreview.breakdown.missing_drug_name ?? 0}
                </span>
                <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                  核心字段不足 {cleanupPreview.breakdown.insufficient_core_fields ?? 0}
                </span>
              </div>
            </div>
          ) : null}
          {cleanupResult ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-[20px] border border-white/8 bg-white/[0.03] p-3 text-sm"
            >
              {cleanupResult.removed > 0 ? (
                <span className="text-emerald-400">
                  已清理 {cleanupResult.removed} 条无效数据，剩余 {cleanupResult.rows_after} 条。
                </span>
              ) : (
                <span className="text-zinc-400">没有需要清理的无效数据。</span>
              )}
            </motion.div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupDialog(false)}>
              {cleanupResult ? "关闭" : "取消"}
            </Button>
            {!cleanupResult ? (
              <Button variant="destructive" onClick={handleCleanup} disabled={cleanupBusy || cleanupPreviewBusy}>
                {cleanupBusy ? <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" /> : null}
                确认清理
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notionDialog} onOpenChange={(o) => { if (!o && !notionBusy) setNotionDialog(false); }}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))]">
          <DialogHeader>
            <DialogTitle className="text-white">推送到 Notion</DialogTitle>
            <DialogDescription className="text-zinc-400">
              将合并后的 {mergedRows?.length ?? 0} 条记录写入 Notion 数据库。
            </DialogDescription>
          </DialogHeader>

          {!notionBusy && !notionResult && !notionError ? (
            <div className="space-y-4">
              <ul className="list-disc space-y-1 pl-4 text-sm text-zinc-400">
                <li>自动检查已有 DOI，跳过重复文献</li>
                <li>数据质量必须大于等于 15%</li>
                <li>必须包含药物名称 `drug_name`</li>
                <li>至少 2 个核心字段有值</li>
                <li>且需至少命中 2 个 GelMA / 释放关键实验字段</li>
              </ul>
              <div className="flex items-center justify-between rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-zinc-200">补全已存在的数据</p>
                  <p className="text-xs text-zinc-500">
                    对重复文献比较本地和 Notion 数据，自动补齐空字段。
                  </p>
                </div>
                <Switch checked={notionPatchExisting} onCheckedChange={setNotionPatchExisting} />
              </div>
            </div>
          ) : null}

          {notionBusy ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-4"
            >
              <div className="flex items-center gap-2 text-sm text-cyan-300">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="truncate">{notionProgress?.message || "正在准备推送..."}</span>
              </div>
              {(notionProgress?.phase === "pushing" || notionProgress?.phase === "patching") && (notionProgress.total ?? 0) > 0 ? (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                    <motion.div
                      className={`h-full rounded-full ${notionProgress.phase === "patching" ? "bg-amber-400" : "bg-cyan-400"}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.round(((notionProgress.current ?? 0) / (notionProgress.total ?? 1)) * 100)}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>{notionProgress.current}/{notionProgress.total}</span>
                    <span className="text-emerald-400">{notionProgress.pushed ?? 0} 写入</span>
                    {(notionProgress.patched ?? 0) > 0 ? <span className="text-amber-300">{notionProgress.patched} 补全</span> : null}
                    {(notionProgress.failed ?? 0) > 0 ? <span className="text-red-400">{notionProgress.failed} 失败</span> : null}
                  </div>
                </>
              ) : null}
            </motion.div>
          ) : null}

          {notionResult ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-2 rounded-[20px] border border-white/8 bg-white/[0.03] p-4 text-sm"
            >
              <div className="flex items-center gap-2 text-emerald-400">
                <Upload className="size-4" />
                <span className="font-medium">推送完成</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-zinc-300">
                <span>成功写入</span>
                <span className="font-medium text-emerald-400">{notionResult.pushed} 条</span>
                {(notionResult.patched ?? 0) > 0 ? (
                  <>
                    <span>数据补全</span>
                    <span className="font-medium text-amber-300">{notionResult.patched} 条</span>
                  </>
                ) : null}
                <span>跳过重复</span>
                <span className="font-medium text-yellow-300">{notionResult.skipped_duplicate} 条</span>
                <span>质量过滤</span>
                <span className="font-medium text-zinc-500">{notionResult.skipped_quality} 条</span>
                <span>总计</span>
                <span className="font-medium">{notionResult.total} 条</span>
              </div>
            </motion.div>
          ) : null}

          {notionError ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-[20px] border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300"
            >
              推送失败：{notionError}
            </motion.div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setNotionDialog(false)} disabled={notionBusy}>
              {notionResult ? "关闭" : "取消"}
            </Button>
            {!notionResult && !notionBusy ? (
              <Button onClick={handleNotionPush} disabled={notionBusy}>
                确认推送
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pubchemDialog} onOpenChange={(o) => { if (!o && !pubchemBusy) setPubchemDialog(false); }}>
        <DialogContent className="border-white/10 bg-[linear-gradient(180deg,rgba(9,12,20,0.98),rgba(8,10,16,0.96))]">
          <DialogHeader>
            <DialogTitle className="text-white">PubChem 药物性质补全</DialogTitle>
            <DialogDescription className="text-zinc-400">
              根据已提取的药物名称，从 PubChem 数据库补充理化性质字段。
            </DialogDescription>
          </DialogHeader>

          {!pubchemBusy && !pubchemResult ? (
            <div className="space-y-4">
              <ul className="list-disc space-y-1 pl-4 text-sm text-zinc-400">
                <li>自动拆分复合药物名称并逐个检索</li>
                <li>并发请求会限流，避免 PubChem API 失败</li>
                <li>失败请求会自动重试，最多 3 次</li>
                <li>补全后的字段会标记来源为 `pubchem`</li>
              </ul>
              <div className="flex items-center justify-between rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-zinc-200">覆盖已有数据</p>
                  <p className="text-xs text-zinc-500">
                    开启后会用 PubChem 的权威值覆盖当前提取结果。
                  </p>
                </div>
                <Switch checked={pubchemForce} onCheckedChange={setPubchemForce} />
              </div>
            </div>
          ) : null}

          {pubchemBusy && !pubchemResult ? (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-emerald-400" />
                <p className="text-sm text-zinc-300">
                  {pubchemProgress?.message || "正在准备查询 PubChem..."}
                </p>
              </div>
              {pubchemProgress?.phase === "lookup" && pubchemProgress.total != null && pubchemProgress.total > 0 ? (
                <div className="space-y-1.5">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                    <motion.div
                      className="h-full rounded-full bg-emerald-400"
                      initial={{ width: 0 }}
                      animate={{ width: `${((pubchemProgress.done || 0) / pubchemProgress.total) * 100}%` }}
                      transition={{ ease: "easeOut" }}
                    />
                  </div>
                  <p className="text-right text-xs text-zinc-500">
                    {pubchemProgress.done || 0} / {pubchemProgress.total} 个药物
                  </p>
                </div>
              ) : null}
              {pubchemProgress?.phase === "enrich" ? (
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">
                    已识别 {pubchemProgress.resolved_drugs} 个，未识别 {pubchemProgress.unresolved_drugs} 个
                  </p>
                  {(pubchemProgress.cache_hit ?? 0) > 0 ? (
                    <p className="text-xs text-emerald-400">
                      缓存命中 {pubchemProgress.cache_hit} 个，减少了重复查询
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {pubchemResult ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-4 text-sm"
            >
              <div className="flex items-center gap-2 text-emerald-400">
                <FlaskConical className="size-4" />
                <span className="font-medium">补全完成</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-zinc-300">
                <span>补全文献数</span>
                <span className="font-medium text-emerald-400">{pubchemResult.enriched_papers} 篇</span>
                <span>补全字段数</span>
                <span className="font-medium text-emerald-400">{pubchemResult.fields_filled} 个</span>
                <span>成功识别药物</span>
                <span className="font-medium text-zinc-200">{pubchemResult.resolved_drugs} 个</span>
                <span>未识别药物</span>
                <span className="font-medium text-amber-300">{pubchemResult.unresolved_drugs} 个</span>
              </div>
            </motion.div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPubchemDialog(false)} disabled={pubchemBusy}>
              {pubchemResult ? "关闭" : "取消"}
            </Button>
            {!pubchemResult && !pubchemBusy ? (
              <Button onClick={handlePubchemEnrich}>
                开始补全
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PaperDetail paper={selectedPaper} open={!!selectedPaper} onClose={() => setSelectedPaper(null)} />
    </div>
  );
}
