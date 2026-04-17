"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Clock3,
  FileInput,
  FileUp,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api, type PipelineMessage, type PipelineTaskStatus, type PipelineTaskSummary } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { TaskMonitorCard } from "@/components/task-monitor-card";

function formatTaskKind(kind: string): string {
  if (kind === "search") return "智能检索";
  if (kind === "doi") return "DOI 导入";
  if (kind === "pdf") return "PDF 导入";
  return kind;
}

function formatTaskState(state: string): string {
  if (state === "running") return "运行中";
  if (state === "done") return "已完成";
  if (state === "cancelled") return "已取消";
  if (state === "error") return "失败";
  return state;
}

function stateClasses(state: string): string {
  if (state === "running") return "border-cyan-400/20 bg-cyan-400/10 text-cyan-200";
  if (state === "done") return "border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
  if (state === "cancelled") return "border-amber-400/20 bg-amber-400/10 text-amber-200";
  if (state === "error") return "border-red-400/20 bg-red-400/10 text-red-200";
  return "border-white/10 bg-white/[0.04] text-zinc-300";
}

function toEpochMs(iso: string): number | null {
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? null : value;
}

function formatDateTime(iso: string): string {
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
      updated_at: updatedAt,
    };
  }

  if (msg.type === "error") {
    return {
      ...task,
      done: true,
      state: task.cancelled ? "cancelled" : "error",
      current_stage: "error",
      progress: 1,
      detail: msg.message ?? task.detail,
      error: msg.message ?? task.error,
      activity_text: "",
      updated_at: updatedAt,
    };
  }

  const data = (msg.data ?? {}) as Record<string, unknown>;
  return {
    ...task,
    state: "running",
    current_stage: msg.stage ?? task.current_stage,
    progress: msg.progress ?? task.progress,
    detail: msg.message ?? task.detail,
    updated_at: updatedAt,
    papers_found: typeof data.papers_found === "number" ? data.papers_found : task.papers_found,
    papers_passed: typeof data.papers_passed === "number" ? data.papers_passed : task.papers_passed,
    rows_extracted: typeof data.rows_extracted === "number" ? data.rows_extracted : task.rows_extracted,
  };
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
  const [cancelling, setCancelling] = useState(false);

  const wsCloseRef = useRef<(() => void) | null>(null);

  const buildTaskUrl = useCallback((taskId: string) => `/tasks?task=${encodeURIComponent(taskId)}`, []);

  const selectTask = useCallback((taskId: string) => {
    router.replace(buildTaskUrl(taskId), { scroll: false });
  }, [router, buildTaskUrl]);

  const loadTasks = useCallback(async () => {
    try {
      const liveTasks = await api.pipeline.live();
      setTasks(liveTasks);
      setTasksError(null);
      if (!selectedTaskId && liveTasks.length > 0) {
        router.replace(buildTaskUrl(liveTasks[0].task_id), { scroll: false });
      }
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "活动任务列表加载失败");
    } finally {
      setTasksLoading(false);
    }
  }, [router, selectedTaskId, buildTaskUrl]);

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

        if (status.done || status.state === "done" || status.state === "error" || status.state === "cancelled") {
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
  }, [selectedTaskId, syncSelectedTask]);

  const handleCancel = useCallback(async () => {
    if (!selectedTaskId || cancelling) return;
    setCancelling(true);
    try {
      await api.pipeline.cancel(selectedTaskId);
      await syncSelectedTask(selectedTaskId);
      await loadTasks();
    } finally {
      setCancelling(false);
    }
  }, [selectedTaskId, cancelling, syncSelectedTask, loadTasks]);

  const selectedSummary = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((task) => task.task_id === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="page-kicker">任务中心</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              跨设备查看当前实例内的活动任务
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              这里会列出当前部署实例上正在运行或刚完成但尚未过期的任务。你可以从任意设备打开同一个任务，继续查看进度、状态和结果概况。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "活动任务", value: String(tasks.length), hint: "当前实例可见" },
              { label: "选中任务", value: selectedTaskId ? "1" : "0", hint: selectedTaskId ? "详情已打开" : "尚未选择" },
              { label: "更新方式", value: "WS + Poll", hint: "实时 + 定时兜底" },
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="page-kicker">活动列表</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">当前任务</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                选择一个任务打开详情。刷新页面或换设备后，只要任务仍在内存保留期内，都可以继续查看。
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadTasks()} disabled={tasksLoading}>
              <RefreshCw className={`size-3.5${tasksLoading ? " animate-spin" : ""}`} data-icon="inline-start" />
              刷新
            </Button>
          </div>

          {tasksError ? (
            <div className="mt-4 rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {tasksError}
            </div>
          ) : null}

          <div className="mt-5 space-y-3">
            {tasks.length === 0 && !tasksLoading ? (
              <div className="rounded-[24px] border border-dashed border-white/10 bg-white/[0.025] px-5 py-6 text-sm text-zinc-500">
                当前没有可查看的活动任务。任务完成后长期结果仍会出现在历史记录中。
              </div>
            ) : null}

            {tasks.map((task) => {
              const active = task.task_id === selectedTaskId;
              const Icon = task.kind === "doi" ? FileInput : task.kind === "pdf" ? FileUp : Search;
              return (
                <button
                  key={task.task_id}
                  type="button"
                  onClick={() => selectTask(task.task_id)}
                  className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                    active
                      ? "border-cyan-300/25 bg-cyan-400/[0.08]"
                      : "border-white/8 bg-white/[0.025] hover:border-white/15"
                  }`}
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
                    <span className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                      更新于 {formatDateTime(task.updated_at)}
                    </span>
                  </div>
                </button>
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
                  任务详情支持通过 `?task=` 参数直达。你可以把当前地址发给另一台设备，直接打开同一任务。
                </p>
              </div>
              {selectedTaskId ? (
                <Link href={buildTaskUrl(selectedTaskId)}>
                  <Button variant="outline" size="sm">
                    <ArrowUpRight className="size-3.5" data-icon="inline-start" />
                    复制型链接
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
                startedAt={toEpochMs(selectedTask.created_at)}
                taskId={selectedTask.task_id}
                onCancel={selectedTask.state === "running" ? handleCancel : undefined}
                cancelling={cancelling}
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
                </div>

                <Separator className="my-5 bg-white/8" />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">创建时间</p>
                    <p className="mt-3 text-sm text-zinc-200">{formatDateTime(selectedTask.created_at)}</p>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">最近更新</p>
                    <p className="mt-3 text-sm text-zinc-200">{formatDateTime(selectedTask.updated_at)}</p>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Link href="/history">
                    <Button variant="outline" size="sm">
                      <Server className="size-3.5" data-icon="inline-start" />
                      去历史记录
                    </Button>
                  </Link>
                  {selectedSummary ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                      <Activity className="size-3.5 text-cyan-300" />
                      列表状态：{formatTaskState(selectedSummary.state)}
                    </span>
                  ) : null}
                  {selectedTask.activity_text ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
                      <Clock3 className="size-3.5 text-cyan-300" />
                      最近活动：{selectedTask.activity_text}
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
