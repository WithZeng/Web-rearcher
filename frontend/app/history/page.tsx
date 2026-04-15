"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Trash2,
  Merge,
  Sparkles,
  Loader2,
  Upload,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api, type HistoryTask, type NotionPushProgress, type PubchemProgress } from "@/lib/api";

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  } | null>(null);
  const [pushedTab, setPushedTab] = useState<"all" | "unpushed" | "pushed">("unpushed");
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [cleanupDialog, setCleanupDialog] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ removed: number; rows_after: number } | null>(null);
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
      const result = await api.history.cleanup(0);
      setCleanupResult({ removed: result.removed, rows_after: result.rows_after });
      if (result.removed > 0) {
        fetchHistory();
        setMergedRows(null);
        setMergeStats(null);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    } finally {
      setCleanupBusy(false);
    }
  }, [fetchHistory]);

  const handlePubchemEnrich = useCallback(async () => {
    setPubchemBusy(true);
    setPubchemResult(null);
    setPubchemProgress(null);
    try {
      const result = await api.history.enrichPubchem(pubchemForce, (progress) => {
        if (progress.phase !== 'heartbeat') {
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
      const result = await api.notion.pushStream(mergedRows, (progress) => {
        setNotionProgress(progress);
      }, notionPatchExisting);
      setNotionResult(result);
      if (result.pushed > 0 || result.patched > 0) {
        await loadMerged(pushedTab);
      }
    } catch (err) {
      setNotionError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotionBusy(false);
      setNotionProgress(null);
    }
  }, [mergedRows, loadMerged, pushedTab, notionPatchExisting]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
          历史记录
        </h1>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索历史查询..."
            className="pl-8"
          />
        </div>
        <Button variant="outline" onClick={handleMerge}>
          <Merge className="size-3.5" data-icon="inline-start" />
          合并去重
        </Button>
        <Button
          variant="outline"
          disabled={pubchemBusy}
          onClick={() => { setPubchemResult(null); setPubchemDialog(true); }}
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
          className="border-red-900/50 text-red-400 hover:bg-red-950/30 hover:text-red-300"
          onClick={() => { setCleanupResult(null); setCleanupDialog(true); }}
        >
          <Sparkles className="size-3.5" data-icon="inline-start" />
          清理无效数据
        </Button>
      </div>

      {/* Merged results */}
      <AnimatePresence>
        {mergedRows && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-3 overflow-hidden"
          >
            {/* Header row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-zinc-200">
                  合并结果：{mergedRows.length} 条
                  {mergeStats && mergeStats.dedupDiscarded > 0 && (
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      （去重丢弃 {mergeStats.dedupDiscarded} 条不完整记录）
                    </span>
                  )}
                </span>
                {mergeStats && (
                  <span className="text-xs text-zinc-500">
                    已推送 {mergeStats.pushedCount} / 未推送 {mergeStats.unpushedCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pubchemBusy}
                  onClick={() => { setPubchemResult(null); setPubchemDialog(true); }}
                >
                  {pubchemBusy ? (
                    <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
                  ) : (
                    <FlaskConical className="size-3.5" data-icon="inline-start" />
                  )}
                  PubChem 补全
                </Button>
                {mergedRows.length > 0 && (
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
                )}
                <ExportMenu rows={mergedRows} />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setMergedRows(null); setMergeStats(null); }}
                >
                  关闭
                </Button>
              </div>
            </div>

            {/* Pushed/Unpushed tabs */}
            <div className="flex items-center gap-1 rounded-lg bg-zinc-900/60 p-0.5 w-fit">
              {([
                { key: "unpushed" as const, label: "未推送", count: mergeStats?.unpushedCount },
                { key: "pushed" as const, label: "已推送", count: mergeStats?.pushedCount },
                { key: "all" as const, label: "全部", count: mergeStats?.totalBefore },
              ]).map(({ key, label, count }) => (
                <button
                  key={key}
                  onClick={() => handleTabChange(key)}
                  className={`relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    pushedTab === key
                      ? "bg-zinc-800 text-zinc-100 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {label}
                  {count != null && (
                    <span className={`ml-1.5 ${
                      pushedTab === key ? "text-zinc-400" : "text-zinc-600"
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <ResultsTable
              rows={mergedRows}
              onRowClick={(row) => setSelectedPaper(row)}
            />
            <Separator />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Task list */}
      {loading ? (
        <p className="text-sm text-zinc-500">加载中...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-zinc-500">暂无历史记录</p>
      ) : (
        <div className="space-y-1">
          {filtered.map((task) => {
            const expanded = expandedTs.has(task.timestamp);
            return (
              <div key={task.timestamp}>
                {/* Task header */}
                <button
                  onClick={() => toggleExpand(task.timestamp)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-zinc-500" />
                  )}
                  <span className="shrink-0 font-mono text-xs text-zinc-600">
                    {formatTimestamp(task.timestamp)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                    {task.query}
                  </span>
                  {task.search_metadata?.databases && task.search_metadata.databases.length > 0 && (
                    <span className="hidden shrink-0 text-[10px] text-zinc-600 sm:inline">
                      {task.search_metadata.databases.join(", ")}
                    </span>
                  )}
                  <Badge variant="secondary" className="shrink-0">
                    {task.count} 篇
                  </Badge>
                </button>

                {/* Expanded content */}
                <AnimatePresence>
                  {expanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-3 px-3 pb-4 pt-1">
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
                            <Trash2
                              className="size-3.5"
                              data-icon="inline-start"
                            />
                            删除
                          </Button>
                        </div>
                        <ResultsTable
                          rows={task.rows}
                          onRowClick={(row) => setSelectedPaper(row)}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除？</DialogTitle>
            <DialogDescription>
              此操作将永久删除该条历史记录，无法恢复。
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

      {/* Cleanup confirmation dialog */}
      <Dialog open={cleanupDialog} onOpenChange={(o) => !o && setCleanupDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理无效数据</DialogTitle>
            <DialogDescription>
              将从所有历史记录中<strong>永久删除</strong>以下数据：
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm text-zinc-400 pl-4 list-disc">
            <li>数据质量 &lt; 15% 的记录（少于 3 个字段有数据）</li>
            <li>缺少药物名称（drug_name）的记录</li>
            <li>核心字段不足 2 个的记录</li>
            <li>清理后的空文件将被自动删除</li>
          </ul>
          {cleanupResult && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm"
            >
              {cleanupResult.removed > 0 ? (
                <span className="text-emerald-400">
                  已清理 {cleanupResult.removed} 条无效数据，剩余 {cleanupResult.rows_after} 条
                </span>
              ) : (
                <span className="text-zinc-400">没有需要清理的无效数据</span>
              )}
            </motion.div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupDialog(false)}>
              {cleanupResult ? "关闭" : "取消"}
            </Button>
            {!cleanupResult && (
              <Button
                variant="destructive"
                onClick={handleCleanup}
                disabled={cleanupBusy}
              >
                {cleanupBusy && <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />}
                确认清理
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notion push dialog */}
      <Dialog open={notionDialog} onOpenChange={(o) => { if (!o && !notionBusy) setNotionDialog(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>推送到 Notion</DialogTitle>
            <DialogDescription>
              将合并后的 {mergedRows?.length ?? 0} 条数据推送到 Notion 数据库。
            </DialogDescription>
          </DialogHeader>

          {!notionBusy && !notionResult && !notionError && (
            <div className="space-y-4">
              <ul className="space-y-1 text-sm text-zinc-400 pl-4 list-disc">
                <li>自动查询 Notion 已有 DOI，跳过重复文献</li>
                <li>数据质量 &ge; 15%（至少 3 个字段有数据）</li>
                <li>必须包含药物名称（drug_name）</li>
                <li>至少 2 个核心字段有值</li>
              </ul>
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-zinc-200">检查未补全数据</p>
                  <p className="text-xs text-zinc-500">
                    对重复文献，比较本地与 Notion 数据，自动补全数据库中的空字段
                  </p>
                </div>
                <Switch checked={notionPatchExisting} onCheckedChange={setNotionPatchExisting} />
              </div>
            </div>
          )}

          {/* Live progress */}
          {notionBusy && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <div className="flex items-center gap-2 text-sm text-blue-400">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="truncate">
                  {notionProgress?.message || "正在准备推送..."}
                </span>
              </div>
              {(notionProgress?.phase === "pushing" || notionProgress?.phase === "patching") && (notionProgress.total ?? 0) > 0 && (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <motion.div
                      className={`h-full rounded-full ${notionProgress.phase === "patching" ? "bg-amber-500" : "bg-blue-500"}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.round(((notionProgress.current ?? 0) / (notionProgress.total ?? 1)) * 100)}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>{notionProgress.current}/{notionProgress.total}</span>
                    <span className="text-emerald-400">{notionProgress.pushed ?? 0} 写入</span>
                    {(notionProgress.patched ?? 0) > 0 && (
                      <span className="text-amber-400">{notionProgress.patched} 补全</span>
                    )}
                    {(notionProgress.failed ?? 0) > 0 && (
                      <span className="text-red-400">{notionProgress.failed} 失败</span>
                    )}
                  </div>
                </>
              )}
              {notionProgress?.phase === "filter_done" && (
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                  <span>待推送 <span className="text-zinc-300">{notionProgress.to_push}</span></span>
                  {(notionProgress.to_patch ?? 0) > 0 && (
                    <span>待补全 <span className="text-amber-400">{notionProgress.to_patch}</span></span>
                  )}
                  <span>质量过滤 <span className="text-zinc-300">{notionProgress.skipped_quality}</span></span>
                  <span>重复跳过 <span className="text-zinc-300">{notionProgress.skipped_duplicate}</span></span>
                </div>
              )}
            </motion.div>
          )}

          {notionResult && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm"
            >
              <div className="flex items-center gap-2 text-emerald-400">
                <Upload className="size-4" />
                <span className="font-medium">推送完成</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-zinc-300">
                <span>成功写入：</span>
                <span className="font-medium text-emerald-400">{notionResult.pushed} 条</span>
                {(notionResult.patched ?? 0) > 0 && (
                  <>
                    <span>数据补全：</span>
                    <span className="font-medium text-amber-400">{notionResult.patched} 条</span>
                  </>
                )}
                <span>跳过重复：</span>
                <span className="font-medium text-yellow-400">{notionResult.skipped_duplicate} 条</span>
                <span>质量过滤：</span>
                <span className="font-medium text-zinc-500">{notionResult.skipped_quality} 条</span>
                <span>总计：</span>
                <span className="font-medium">{notionResult.total} 条</span>
              </div>
            </motion.div>
          )}

          {notionError && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-400"
            >
              推送失败：{notionError}
            </motion.div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setNotionDialog(false)} disabled={notionBusy}>
              {notionResult ? "关闭" : "取消"}
            </Button>
            {!notionResult && !notionBusy && (
              <Button onClick={handleNotionPush} disabled={notionBusy}>
                确认推送
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PubChem enrichment dialog */}
      <Dialog open={pubchemDialog} onOpenChange={(o) => { if (!o && !pubchemBusy) setPubchemDialog(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PubChem 药物性质补全</DialogTitle>
            <DialogDescription>
              根据已提取的药物名称，从 PubChem 数据库自动补全药物化学性质（TPSA、HBD、HBA、LogP、分子量等）。
            </DialogDescription>
          </DialogHeader>

          {!pubchemBusy && !pubchemResult && (
            <div className="space-y-4">
              <ul className="space-y-1 text-sm text-zinc-400 pl-4 list-disc">
                <li>自动拆分复合药物名（如 &quot;A; B&quot;）分别查询</li>
                <li>限流并发请求，避免 PubChem API 限速失败</li>
                <li>自动重试失败请求（最多 3 次）</li>
                <li>补全后的数据标记来源为 &quot;pubchem&quot;</li>
              </ul>
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-zinc-200">覆盖已有数据</p>
                  <p className="text-xs text-zinc-500">
                    开启后用 PubChem 权威数据替换 LLM 提取值
                  </p>
                </div>
                <Switch checked={pubchemForce} onCheckedChange={setPubchemForce} />
              </div>
            </div>
          )}

          {pubchemBusy && !pubchemResult && (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-emerald-400" />
                <p className="text-sm text-zinc-300">
                  {pubchemProgress?.message || "正在准备查询 PubChem…"}
                </p>
              </div>
              {pubchemProgress?.phase === 'lookup' && pubchemProgress.total != null && pubchemProgress.total > 0 && (
                <div className="space-y-1.5">
                  <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-emerald-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${((pubchemProgress.done || 0) / pubchemProgress.total) * 100}%` }}
                      transition={{ ease: "easeOut" }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 text-right">
                    {pubchemProgress.done || 0} / {pubchemProgress.total} 种药物
                  </p>
                </div>
              )}
              {pubchemProgress?.phase === 'enrich' && (
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">
                    识别 {pubchemProgress.resolved_drugs} 种，未识别 {pubchemProgress.unresolved_drugs} 种
                  </p>
                  {(pubchemProgress.cache_hit ?? 0) > 0 && (
                    <p className="text-xs text-emerald-500">
                      缓存命中 {pubchemProgress.cache_hit} 种（跳过重复查询）
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {pubchemResult && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm"
            >
              <div className="flex items-center gap-2 text-emerald-400">
                <FlaskConical className="size-4" />
                <span className="font-medium">补全完成</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-zinc-300">
                <span>补全论文数：</span>
                <span className="font-medium text-emerald-400">{pubchemResult.enriched_papers} 篇</span>
                <span>补全字段数：</span>
                <span className="font-medium text-emerald-400">{pubchemResult.fields_filled} 个</span>
                <span>成功识别药物：</span>
                <span className="font-medium text-zinc-200">{pubchemResult.resolved_drugs} 种</span>
                <span>未识别药物：</span>
                <span className="font-medium text-amber-400">{pubchemResult.unresolved_drugs} 种</span>
              </div>
              {pubchemResult.unresolved_drugs > 0 && (
                <p className="text-xs text-zinc-500 pt-1">
                  未识别的药物可能是复合名、缩写或非标准命名，PubChem 无法匹配。
                </p>
              )}
            </motion.div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPubchemDialog(false)} disabled={pubchemBusy}>
              {pubchemResult ? "关闭" : "取消"}
            </Button>
            {!pubchemResult && !pubchemBusy && (
              <Button onClick={handlePubchemEnrich}>
                开始补全
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PaperDetail
        paper={selectedPaper}
        open={!!selectedPaper}
        onClose={() => setSelectedPaper(null)}
      />
    </div>
  );
}
