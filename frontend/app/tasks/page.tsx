"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  CheckSquare,
  Clock3,
  FileInput,
  FileUp,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  api,
  type BatchTaskResponse,
  type PipelineMessage,
  type PipelineTaskStatus,
  type PipelineTaskSummary,
} from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { TaskMonitorCard } from "@/components/task-monitor-card";

function formatTaskKind(kind: string): string {
  if (kind === "search") return "智能检索";
  if (kind === "doi") return "DOI 导入";
  if (kind === "pdf") return "PDF 导入";
  return kind;
}

function formatTaskState(state: string): string {
  if (state === "queued") return "排队中";
  if (state === "running") return "运行中";
  if (state === "done") return "已完成";
  if (state === "cancelled") return "已取消";
  if (state === "error") return "失败";
  return state;
}

function stateClasses(state: string): string {
  if (state === "queued") return "border-amber-400/20 bg-amber-400/10 text-amber-200";
  if (state === "running") return "border-cyan-400/20 bg-cyan-400/10 text-cyan-200";
  if (state === "done") return "border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
  if (state === "cancelled") return "border-orange-400/20 bg-orange-400/10 text-orange-200";
  if (state === "error") return "border-red-400/20 bg-red-400/10 text-red-200";
  return "border-white/10 bg-white/[0.04] text-zinc-300";
}

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return value.toLocaleString();
}

function updateTaskWithMessage(task: PipelineTaskStatus, msg: PipelineMessage): PipelineTaskStatus {
  const updatedAt = new Date().toISOString();

  if (msg.type === "activity") {
    return {
      ...task,
      activity_text: msg.activityText ?? task.activity_text,
      updated_at: updatedAt,
    };
  }

  if (msg.type === "complete") {
    return {
      ...task,
      done: true,
      state: "done",
      current_stage: "done",
      progress: 1,
      detail: msg.message ?? task.detail,
      activity_text: "",
      queue_position: null,
      updated_at: updatedAt,
    };
  }

  if (msg.type === "error") {
    const nextState = msg.state === "cancelled" ? "cancelled" : "error";
    return {
      ...task,
      done: true,
      state: nextState,
      current_stage: "error",
      progress: 1,
      detail: msg.message ?? task.detail,
      error: msg.message ?? task.error,
      activity_text: "",
      queue_position: null,
      updated_at: updatedAt,
    };
  }

  const data = (msg.data ?? {}) as Record<string, unknown>;
  return {
    ...task,
    done: false,
    state: msg.state ?? task.state,
    current_stage: msg.stage ?? task.current_stage,
    progress: msg.progress ?? task.progress,
    detail: msg.message ?? task.detail,
    queue_position: msg.queuePosition ?? task.queue_position,
    started_at: msg.startedAt ?? task.started_at,
    updated_at: updatedAt,
    papers_found: typeof data.papers_found === "number" ? data.papers_found : task.papers_found,
    papers_passed: typeof data.papers_passed === "number" ? data.papers_passed : task.papers_passed,
    rows_extracted: typeof data.rows_extracted === "number" ? data.rows_extracted : task.rows_extracted,
  };
}

function buildBatchMessage(prefix: string, result: BatchTaskResponse): string {
  const success = result.affected_task_ids.length;
  const skipped = result.skipped.length;
  return skipped > 0 ? `${prefix} ${success} 个，跳过 ${skipped} 个` : `${prefix} ${success} 个`;
}

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams.get("task");

  const [tasks, setTasks] = useState<PipelineTaskSummary[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<PipelineTaskStatus | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<"cancel" | "remove" | null>(null);
  const [cancellingSingle, setCancellingSingle] = useState(false);

  const wsCloseRef = useRef<(() => void) | null>(null);

  const buildTaskUrl = useCallback((taskId: string | null) => {
    if (!taskId) return "/tasks";
    return `/tasks?task=${encodeURIComponent(taskId)}`;
  }, []);

  const selectTask = useCallback((taskId: string | null) => {
    router.replace(buildTaskUrl(taskId), { scroll: false });
  }, [router, buildTaskUrl]);

  const syncSelection = useCallback((liveTasks: PipelineTaskSummary[]) => {
    setSelectedIds((current) => current.filter((taskId) => liveTasks.some((task) => task.task_id === taskId)));
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const liveTasks = await api.pipeline.live();
      setTasks(liveTasks);
      syncSelection(liveTasks);
      setTasksError(null);

      if (!selectedTaskId) {
        if (liveTasks.length > 0) {
          selectTask(liveTasks[0].task_id);
        }
        return;
      }

      if (!liveTasks.some((task) => task.task_id === selectedTaskId)) {
        if (liveTasks.length > 0) {
          selectTask(liveTasks[0].task_id);
        } else {
          selectTask(null);
        }
      }
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "活动任务列表加载失败");
    } finally {
      setTasksLoading(false);
    }
  }, [selectedTaskId, selectTask, syncSelection]);

  const syncSelectedTask = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    try {
      const status = await api.pipeline.status(taskId);
      setSelectedTask(status);
      setDetailError(null);
    } catch (error) {
      setSelectedTask(null);
      setDetailError(error instanceof Error ? error.message : "任务详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => {
      void loadTasks();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  useEffect(() => {
    if (!selectedTaskId) {
      wsCloseRef.current?.();
      wsCloseRef.current = null;
      setSelectedTask(null);
      setDetailError(null);
      return;
    }

    let cancelled = false;

    const handleMessage = (msg: PipelineMessage) => {
      if (cancelled) return;
      setSelectedTask((current) => (current ? updateTaskWithMessage(current, msg) : current));
    };

    const syncStatus = async () => {
      try {
        const status = await api.pipeline.status(selectedTaskId);
        if (cancelled) return;

        setSelectedTask(status);
        setDetailError(null);

        if (status.done) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          return;
        }

        if (!wsCloseRef.current) {
          const { close } = connectPipeline(selectedTaskId, handleMessage, () => {
            wsCloseRef.current = null;
          });
          wsCloseRef.current = close;
        }
      } catch (error) {
        if (!cancelled) {
          setSelectedTask(null);
          setDetailError(error instanceof Error ? error.message : "任务详情加载失败");
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };

    setDetailLoading(true);
    void syncStatus();
    const timer = window.setInterval(() => {
      void syncStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      wsCloseRef.current?.();
      wsCloseRef.current = null;
    };
  }, [selectedTaskId]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((current) =>
      current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId],
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => (current.length === tasks.length ? [] : tasks.map((task) => task.task_id)));
  }, [tasks]);

  const handleCancel = useCallback(async () => {
    if (!selectedTaskId || cancellingSingle) return;
    setCancellingSingle(true);
    try {
      await api.pipeline.cancel(selectedTaskId);
      await syncSelectedTask(selectedTaskId);
      await loadTasks();
    } finally {
      setCancellingSingle(false);
    }
  }, [selectedTaskId, cancellingSingle, syncSelectedTask, loadTasks]);

  const runBatchAction = useCallback(async (mode: "cancel" | "remove") => {
    if (selectedIds.length === 0 || actionBusy) return;
    setActionBusy(mode);
    setActionMessage(null);
    try {
      const result = mode === "cancel"
        ? await api.pipeline.cancelBatch(selectedIds)
        : await api.pipeline.removeBatch(selectedIds);
      setActionMessage(buildBatchMessage(mode === "cancel" ? "已处理" : "已移除", result));
      setSelectedIds([]);
      await loadTasks();
      if (selectedTaskId) {
        await syncSelectedTask(selectedTaskId).catch(() => undefined);
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "批量操作失败");
    } finally {
      setActionBusy(null);
    }
  }, [selectedIds, actionBusy, loadTasks, selectedTaskId, syncSelectedTask]);

  const selectedSummary = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((task) => task.task_id === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  const selectedCount = selectedIds.length;

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="page-kicker">任务中心</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              统一查看运行中、排队中与已结束的任务
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              这里会持续展示当前实例里仍在内存中的活动任务。你可以继续新建任务、观察排队顺序，并在这里做批量取消或批量清理。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "活动任务", value: String(tasks.length), hint: "当前可见" },
              { label: "已选任务", value: String(selectedCount), hint: selectedCount ? "可批量操作" : "未选择" },
              { label: "同步方式", value: "WS + Poll", hint: "实时 + 轮询兜底" },
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

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="panel p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="page-kicker">活动列表</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">当前任务</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                支持多选批量取消排队/运行中的任务，或批量移除已结束任务。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={toggleSelectAll} disabled={tasks.length === 0}>
                <CheckSquare className="size-3.5" data-icon="inline-start" />
                {selectedCount === tasks.length && tasks.length > 0 ? "取消全选" : "全选"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void loadTasks()} disabled={tasksLoading}>
                <RefreshCw className={`size-3.5${tasksLoading ? " animate-spin" : ""}`} data-icon="inline-start" />
                刷新
              </Button>
            </div>
          </div>

          {selectedCount > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-[20px] border border-white/8 bg-white/[0.03] p-3">
              <span className="text-sm text-zinc-300">已选择 {selectedCount} 个任务</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runBatchAction("cancel")}
                disabled={actionBusy !== null}
              >
                <XCircle className="size-3.5" data-icon="inline-start" />
                {actionBusy === "cancel" ? "处理中..." : "批量取消"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runBatchAction("remove")}
                disabled={actionBusy !== null}
              >
                <Trash2 className="size-3.5" data-icon="inline-start" />
                {actionBusy === "remove" ? "处理中..." : "批量删除"}
              </Button>
            </div>
          ) : null}

          {actionMessage ? (
            <div className="mt-4 rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
              {actionMessage}
            </div>
          ) : null}

          {tasksError ? (
            <div className="mt-4 rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {tasksError}
            </div>
          ) : null}

          <div className="mt-5 space-y-3">
            {tasks.length === 0 && !tasksLoading ? (
              <div className="rounded-[24px] border border-dashed border-white/10 bg-white/[0.025] px-5 py-6 text-sm text-zinc-500">
                当前没有可查看的活动任务。新任务开始后会立刻出现在这里。
              </div>
            ) : null}

            {tasks.map((task) => {
              const active = task.task_id === selectedTaskId;
              const checked = selectedIds.includes(task.task_id);
              const Icon = task.kind === "doi" ? FileInput : task.kind === "pdf" ? FileUp : Search;

              return (
                <div
                  key={task.task_id}
                  className={`rounded-[24px] border px-4 py-4 transition ${
                    active
                      ? "border-cyan-300/25 bg-cyan-400/[0.08]"
                      : "border-white/8 bg-white/[0.025] hover:border-white/15"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(task.task_id)}
                      className="mt-1 size-4 rounded border-white/15 bg-black/20"
                    />
                    <button
                      type="button"
                      onClick={() => selectTask(task.task_id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm text-zinc-100">
                            <Icon className="size-4 shrink-0 text-cyan-300" />
                            <span className="truncate font-medium">{task.title}</span>
                          </div>
                          <p className="mt-2 text-xs text-zinc-500">{task.task_id}</p>
                          <p className="mt-2 text-sm text-zinc-400">{task.detail || "等待任务进度"}</p>
                        </div>
                        <Badge className={stateClasses(task.state)}>{formatTaskState(task.state)}</Badge>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                          {formatTaskKind(task.kind)}
                        </span>
                        <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                          {Math.round(task.progress * 100)}%
                        </span>
                        {typeof task.queue_position === "number" ? (
                          <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                            队列第 {task.queue_position} 位
                          </span>
                        ) : null}
                        <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                          更新于 {formatDateTime(task.updated_at)}
                        </span>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-6">
          <div className="panel p-5 md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="page-kicker">任务详情</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">实时监控</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  任务详情支持通过 `?task=` 参数直达，你可以把当前地址发到另一台设备继续查看。
                </p>
              </div>
              {selectedTaskId ? (
                <Link href={buildTaskUrl(selectedTaskId)}>
                  <Button variant="outline" size="sm">
                    <ArrowUpRight className="size-3.5" data-icon="inline-start" />
                    打开直达链接
                  </Button>
                </Link>
              ) : null}
            </div>

            {detailError ? (
              <div className="mt-4 rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {detailError}
              </div>
            ) : null}

            {!selectedTaskId && !detailLoading ? (
              <div className="mt-5 rounded-[24px] border border-dashed border-white/10 bg-white/[0.025] px-5 py-6 text-sm text-zinc-500">
                从左侧选择一个任务查看详情。
              </div>
            ) : null}

            {detailLoading && !selectedTask ? (
              <div className="mt-5 rounded-[24px] border border-white/8 bg-white/[0.025] px-5 py-6 text-sm text-zinc-400">
                正在加载任务详情...
              </div>
            ) : null}
          </div>

          {selectedTask ? (
            <>
              <TaskMonitorCard
                state={selectedTask.state}
                queuePosition={selectedTask.queue_position ?? null}
                currentStage={selectedTask.current_stage}
                stageMessage={selectedTask.detail}
                progress={selectedTask.progress}
                stageData={{
                  papers_found: selectedTask.papers_found ?? undefined,
                  papers_passed: selectedTask.papers_passed ?? undefined,
                  rows_extracted: selectedTask.rows_extracted ?? undefined,
                }}
                activityText={selectedTask.activity_text}
                running={selectedTask.state === "running"}
                startedAt={toEpochMs(selectedTask.started_at)}
                taskId={selectedTask.task_id}
                onCancel={["queued", "running"].includes(selectedTask.state) ? handleCancel : undefined}
                cancelling={cancellingSingle}
              />

              <div className="panel p-5 md:p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge className={stateClasses(selectedTask.state)}>{formatTaskState(selectedTask.state)}</Badge>
                  <Badge variant="outline" className="border-white/10 text-zinc-300">
                    {formatTaskKind(selectedTask.kind)}
                  </Badge>
                  {selectedTask.result_count !== null ? (
                    <Badge variant="outline" className="border-white/10 text-zinc-300">
                      结果 {selectedTask.result_count} 条
                    </Badge>
                  ) : null}
                  {typeof selectedTask.queue_position === "number" ? (
                    <Badge variant="outline" className="border-white/10 text-zinc-300">
                      前方还有 {Math.max(selectedTask.queue_position - 1, 0)} 个任务
                    </Badge>
                  ) : null}
                </div>

                <Separator className="my-5 bg-white/8" />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">创建时间</p>
                    <p className="mt-3 text-sm text-zinc-200">{formatDateTime(selectedTask.created_at)}</p>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">开始时间</p>
                    <p className="mt-3 text-sm text-zinc-200">{formatDateTime(selectedTask.started_at)}</p>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Link href="/history">
                    <Button variant="outline" size="sm">
                      <Activity className="size-3.5" data-icon="inline-start" />
                      去历史记录
                    </Button>
                  </Link>
                  {selectedSummary ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                      <Clock3 className="size-3.5 text-cyan-300" />
                      列表状态：{formatTaskState(selectedSummary.state)}
                    </span>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function TasksPageFallback() {
  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="rounded-[24px] border border-white/10 bg-black/20 p-6 text-sm text-zinc-400">
          正在加载任务中心...
        </div>
      </section>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<TasksPageFallback />}>
      <TasksPageContent />
    </Suspense>
  );
}
