"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Brain,
  Check,
  Clock,
  Download,
  FileText,
  Filter,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";

const STAGES = [
  { key: "planner", label: "规划", icon: Brain },
  { key: "search", label: "检索", icon: FileText },
  { key: "retrieval", label: "获取", icon: Download },
  { key: "quality_filter", label: "筛选", icon: Filter },
  { key: "extraction", label: "提取", icon: Brain },
  { key: "reviewer", label: "复核", icon: ShieldCheck },
  { key: "done", label: "完成", icon: Check },
] as const;

function stageIndex(stage: string): number {
  if (stage === "complete" || stage === "done") return STAGES.length;
  const mapped: Record<string, string> = {
    extraction_sub_agents: "extraction",
    extraction_merge: "extraction",
    reviewer_retry: "reviewer",
  };
  const key = mapped[stage] ?? stage;
  const idx = STAGES.findIndex((item) => item.key === key);
  return idx === -1 ? -1 : idx;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PipelineProgress() {
  const {
    currentStage,
    stageMessage,
    progress,
    stageData,
    activityText,
    running,
    startedAt,
    taskId,
  } = useAppStore((state) => state.pipeline);
  const setPipelineField = useAppStore((state) => state.setPipelineField);
  const safeStageData = stageData && typeof stageData === "object" ? stageData : {};
  const activeIdx = stageIndex(currentStage);
  const isComplete = currentStage === "complete" || currentStage === "done";

  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!taskId || cancelling) return;
    setCancelling(true);
    try {
      await api.pipeline.cancel(taskId);
      setPipelineField("running", false);
      setPipelineField("currentStage", "error");
      setPipelineField("stageMessage", "任务已取消");
      setPipelineField("activityText", "");
      setPipelineField("error", "任务已取消");
    } catch (error) {
      setPipelineField("error", error instanceof Error ? error.message : "取消任务失败");
    } finally {
      setCancelling(false);
    }
  }, [taskId, cancelling, setPipelineField]);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - startedAt);
    if (isComplete) return;

    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt, isComplete]);

  const metrics = [
    { label: "检索命中", value: Number(safeStageData.papers_found), unit: "篇" },
    { label: "通过筛选", value: Number(safeStageData.papers_passed), unit: "篇" },
    { label: "已提取", value: Number(safeStageData.rows_extracted), unit: "条" },
  ].filter((item) => !Number.isNaN(item.value) && item.value > 0);

  return (
    <div className="panel overflow-hidden p-5 md:p-6">
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-kicker">Pipeline Status</p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-white">
              {isComplete ? "流水线已完成" : running ? "任务正在处理中" : "等待执行"}
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
              {isComplete
                ? `本次任务已结束${startedAt ? `，总耗时 ${formatElapsed(elapsed)}` : ""}。`
                : stageMessage || "系统正在等待下一步进度更新。"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {startedAt ? (
              <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs tabular-nums text-zinc-400">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-3.5" />
                  {formatElapsed(elapsed)}
                </span>
              </div>
            ) : null}

            {running && !isComplete ? (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="inline-flex items-center gap-2 rounded-full border border-red-500/20 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/15 disabled:opacity-50"
                title="取消任务"
              >
                <XCircle className="size-3.5" />
                {cancelling ? "取消中..." : "取消任务"}
              </button>
            ) : null}
          </div>
        </div>

        <div className="relative px-2">
          <div className="absolute left-5 right-5 top-5 h-px bg-white/8" />
          <motion.div
            className="absolute left-5 top-5 h-px bg-cyan-300"
            initial={{ width: "0%" }}
            animate={{
              width: isComplete
                ? "calc(100% - 2.5rem)"
                : activeIdx <= 0
                  ? "0%"
                  : `calc(${(activeIdx / (STAGES.length - 1)) * 100}% - ${(activeIdx / (STAGES.length - 1)) * 2.5}rem)`,
            }}
            transition={{ duration: 0.45, ease: "easeInOut" }}
          />

          <div className="grid grid-cols-7 gap-2">
            {STAGES.map((stage, index) => {
              const Icon = stage.icon;
              const completed = index < activeIdx || isComplete;
              const active = index === activeIdx && !isComplete;

              return (
                <div key={stage.key} className="relative z-10 flex flex-col items-center gap-3 text-center">
                  <div
                    className={`flex size-10 items-center justify-center rounded-2xl border transition-all ${
                      active
                        ? "border-cyan-300/30 bg-cyan-300/15 text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.18)]"
                        : completed
                          ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-100"
                          : "border-white/8 bg-white/[0.03] text-zinc-500"
                    }`}
                  >
                    {completed && !active ? <Check className="size-4" /> : <Icon className="size-4" />}
                  </div>
                  <div>
                    <p className={`text-xs font-medium ${active || completed ? "text-zinc-100" : "text-zinc-500"}`}>
                      {stage.label}
                    </p>
                    <p className="mt-1 text-[11px] text-zinc-600">
                      {active ? "进行中" : completed ? "完成" : "待执行"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <motion.div
                className="h-full rounded-full bg-[linear-gradient(90deg,#67e8f9,#38bdf8)]"
                initial={{ width: "0%" }}
                animate={{ width: `${Math.round(progress * 100)}%` }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                layout
              />
            </div>
            <span className="w-12 text-right text-sm font-medium tabular-nums text-zinc-300">
              {Math.round(progress * 100)}%
            </span>
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <AnimatePresence mode="wait">
              {running && activityText ? (
                <motion.div
                  key={activityText}
                  className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-full border border-white/8 bg-white/[0.03] px-3 py-2"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16 }}
                >
                  <motion.span
                    className="inline-block size-2 shrink-0 rounded-full bg-cyan-300"
                    animate={{ opacity: [1, 0.35, 1] }}
                    transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <p className="truncate font-mono text-[11px] text-zinc-400">{activityText}</p>
                </motion.div>
              ) : (
                <motion.p
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-sm text-zinc-500"
                >
                  {running ? "等待更详细的阶段信息..." : "任务未运行。"}
                </motion.p>
              )}
            </AnimatePresence>

            {metrics.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {metrics.map((item) => (
                  <span
                    key={item.label}
                    className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-2 text-xs text-zinc-400"
                  >
                    {item.label}
                    <span className="ml-2 font-semibold tabular-nums text-zinc-100">
                      {item.value}
                    </span>
                    <span className="ml-1 text-zinc-500">{item.unit}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
