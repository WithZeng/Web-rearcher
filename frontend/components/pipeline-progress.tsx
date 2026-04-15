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
  { key: "reviewer", label: "审查", icon: ShieldCheck },
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
  const { currentStage, stageMessage, progress, stageData, activityText, running, startedAt, taskId } =
    useAppStore((state) => state.pipeline);
  const setPipelineField = useAppStore((state) => state.setPipelineField);
  const safeStageData = stageData ?? {};
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
    { label: "检索到", value: safeStageData.papers_found, unit: "篇" },
    { label: "通过筛选", value: safeStageData.papers_passed, unit: "篇" },
    { label: "已提取", value: safeStageData.rows_extracted, unit: "条" },
  ].filter((item) => item.value != null && item.value > 0);

  return (
    <div className="w-full space-y-3">
      <div className="relative flex items-center justify-between px-2">
        <div className="absolute top-3 left-6 right-6 h-0.5 bg-zinc-700" />
        <motion.div
          className="absolute top-3 left-6 h-0.5 bg-blue-500"
          initial={{ width: "0%" }}
          animate={{
            width: isComplete
              ? "calc(100% - 3rem)"
              : activeIdx <= 0
                ? "0%"
                : `calc(${(activeIdx / (STAGES.length - 1)) * 100}% - ${(activeIdx / (STAGES.length - 1)) * 3}rem)`,
          }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
        />

        {STAGES.map((stage, index) => {
          const completed = index < activeIdx || isComplete;
          const active = index === activeIdx && !isComplete;

          return (
            <div key={stage.key} className="relative z-10 flex flex-col items-center gap-1">
              {active ? (
                <motion.div
                  className="flex size-6 items-center justify-center rounded-full bg-blue-600 shadow-[0_0_8px_rgba(59,130,246,0.6)]"
                  animate={{ scale: [1, 1.15, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <div className="size-2 rounded-full bg-white" />
                </motion.div>
              ) : (
                <motion.div
                  className={`flex size-6 items-center justify-center rounded-full transition-colors ${
                    completed ? "bg-blue-600" : "bg-zinc-700"
                  }`}
                  animate={{ backgroundColor: completed ? "#2563eb" : "#3f3f46" }}
                  transition={{ duration: 0.3 }}
                >
                  {completed ? (
                    <Check className="size-3.5 text-white" strokeWidth={3} />
                  ) : (
                    <div className="size-2 rounded-full bg-zinc-500" />
                  )}
                </motion.div>
              )}
              <span
                className={`text-[10px] leading-none ${
                  completed || active ? "text-blue-400" : "text-zinc-500"
                }`}
              >
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
          <motion.div
            className="h-full bg-blue-500"
            initial={{ width: "0%" }}
            animate={{ width: `${Math.round(progress * 100)}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            layout
          />
        </div>
        <span className="w-10 text-right text-xs tabular-nums text-zinc-400">
          {Math.round(progress * 100)}%
        </span>
        {startedAt && (
          <span className="flex items-center gap-1 text-xs tabular-nums text-zinc-500">
            <Clock className="size-3" />
            {formatElapsed(elapsed)}
          </span>
        )}
        {running && !isComplete && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-red-400 transition-colors hover:bg-red-400/10 hover:text-red-300 disabled:opacity-50"
            title="取消任务"
          >
            <XCircle className="size-3.5" />
            {cancelling ? "取消中..." : "取消"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <AnimatePresence mode="wait">
          <motion.p
            key={stageMessage}
            className={`text-xs ${isComplete ? "text-green-400" : "text-zinc-400"}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {isComplete
              ? `流水线已完成${startedAt ? ` (耗时 ${formatElapsed(elapsed)})` : ""}`
              : stageMessage || "等待中..."}
          </motion.p>
        </AnimatePresence>

        {metrics.length > 0 && (
          <motion.div
            className="flex items-center gap-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            {metrics.map((item) => (
              <span key={item.label} className="text-xs text-zinc-500">
                {item.label}{" "}
                <motion.span
                  key={item.value}
                  className="font-medium tabular-nums text-zinc-200"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {item.value}
                </motion.span>{" "}
                {item.unit}
              </span>
            ))}
          </motion.div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {running && activityText && (
          <motion.div
            key={activityText}
            className="flex items-center gap-2 overflow-hidden"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <motion.span
              className="inline-block size-1.5 shrink-0 rounded-full bg-blue-400"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            />
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {activityText}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
