"use client";

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { TaskMonitorCard } from "@/components/task-monitor-card";

export function PipelineProgress() {
  const {
    state,
    queuePosition,
    currentStage,
    stageMessage,
    progress,
    stageData,
    activityText,
    running,
    startedAt,
    taskId,
  } = useAppStore((store) => store.pipeline);
  const setPipelineField = useAppStore((store) => store.setPipelineField);

  const [cancelling, setCancelling] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!taskId || cancelling) return;
    setCancelling(true);
    try {
      await api.pipeline.cancel(taskId);
      setPipelineField("state", "cancelled");
      setPipelineField("queuePosition", null);
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

  return (
    <TaskMonitorCard
      state={state}
      queuePosition={queuePosition}
      currentStage={currentStage}
      stageMessage={stageMessage}
      progress={progress}
      stageData={stageData}
      activityText={activityText}
      running={running}
      startedAt={startedAt}
      taskId={taskId}
      onCancel={handleCancel}
      cancelling={cancelling}
    />
  );
}
