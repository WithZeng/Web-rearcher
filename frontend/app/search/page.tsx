"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Loader2, Search, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { useAppStore } from "@/lib/store";

export default function SearchPage() {
  const meta = useAppStore((store) => store.meta);
  const setMeta = useAppStore((store) => store.setMeta);
  const pipeline = useAppStore((store) => store.pipeline);
  const setPipelineField = useAppStore((store) => store.setPipelineField);
  const resetPipeline = useAppStore((store) => store.resetPipeline);
  const handlePipelineMessage = useAppStore((store) => store.handlePipelineMessage);
  const searchParams = useAppStore((store) => store.searchParams);
  const setSearchParam = useAppStore((store) => store.setSearchParam);

  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const wsCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.meta().then((payload) => {
      setMeta(payload);
      if (searchParams.selectedDbs.length === 0) {
        setSearchParam("selectedDbs", payload.default_databases);
      }
    });
  }, [setMeta, searchParams.selectedDbs.length, setSearchParam]);

  useEffect(() => {
    const taskId = pipeline.taskId;
    const alreadyDone = ["done", "error", "cancelled"].includes(pipeline.state);
    if (!taskId || alreadyDone) return;

    let cancelled = false;

    const syncTaskStatus = async () => {
      try {
        const status = await api.pipeline.status(taskId);
        if (cancelled) return;

        setPipelineField("state", status.state);
        setPipelineField("queuePosition", status.queue_position ?? null);
        setPipelineField("running", status.state === "running");
        setPipelineField("startedAt", status.started_at ? new Date(status.started_at).getTime() : null);
        setPipelineField("currentStage", status.current_stage ?? "");
        setPipelineField("stageMessage", status.detail);

        if (status.error) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "error", message: status.error, state: status.state });
          return;
        }

        if (status.done) {
          wsCloseRef.current?.();
          wsCloseRef.current = null;
          handlePipelineMessage({ type: "complete" });
          return;
        }

        if (!wsCloseRef.current) {
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
  }, [pipeline.taskId, pipeline.state, pipeline.currentStage, setPipelineField, handlePipelineMessage]);

  useEffect(() => {
    return () => {
      wsCloseRef.current?.();
    };
  }, []);

  const toggleDb = useCallback((db: string) => {
    setSearchParam(
      "selectedDbs",
      searchParams.selectedDbs.includes(db)
        ? searchParams.selectedDbs.filter((item) => item !== db)
        : [...searchParams.selectedDbs, db],
    );
  }, [searchParams.selectedDbs, setSearchParam]);

  const handleSearch = useCallback(async () => {
    if (!searchParams.query.trim() || submitting) return;

    resetPipeline();
    setSubmitting(true);

    try {
      const result = await api.pipeline.run({
        query: searchParams.query.trim(),
        limit: searchParams.limit,
        target_passed_count: searchParams.targetPassedCount ?? undefined,
        databases: searchParams.selectedDbs,
        mode: searchParams.mode,
        use_planner: searchParams.usePlanner,
        fetch_concurrency: searchParams.fetchConcurrency,
        llm_concurrency: searchParams.llmConcurrency,
      });

      setPipelineField("taskId", result.task_id);
      setPipelineField("state", result.state);
      setPipelineField("queuePosition", result.queue_position ?? null);
      setPipelineField("running", result.state === "running");
      setPipelineField("progress", 0);
      setPipelineField("startedAt", result.state === "running" ? Date.now() : null);
      setPipelineField("currentStage", result.state === "queued" ? "queued" : "");
      setPipelineField(
        "stageMessage",
        result.state === "queued" && typeof result.queue_position === "number"
          ? `Queued at position ${result.queue_position}`
          : "",
      );
      setPipelineField("error", null);
      setPipelineField("rows", []);
      setPipelineField("stats", null);

      wsCloseRef.current?.();
      const { close } = connectPipeline(result.task_id, handlePipelineMessage, () => {
        wsCloseRef.current = null;
      });
      wsCloseRef.current = close;
    } catch (error) {
      setPipelineField("error", error instanceof Error ? error.message : "Search request failed");
    } finally {
      setSubmitting(false);
    }
  }, [searchParams, submitting, resetPipeline, setPipelineField, handlePipelineMessage]);

  const showProgress = Boolean(pipeline.taskId) || pipeline.rows.length > 0;

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              <Sparkles className="size-3.5" />
              Queue-aware literature search
            </div>
            <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-white md:text-5xl">
              Submit a new search even while another task is already running.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              Search tasks now join the shared queue used by DOI and PDF imports. This page keeps monitoring the task you most recently submitted.
            </p>

            <div className="mt-7 flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <Input
                  className="h-14 rounded-full border-white/10 bg-black/20 pl-11 pr-4 text-base text-zinc-100 placeholder:text-zinc-600"
                  placeholder="e.g. glioblastoma temozolomide resistance"
                  value={searchParams.query}
                  onChange={(event) => setSearchParam("query", event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void handleSearch()}
                />
              </div>

              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  className="h-14 w-24 rounded-full border-white/10 bg-black/20 text-center text-base text-zinc-100"
                  min={1}
                  max={20000}
                  value={searchParams.limit}
                  onChange={(event) => setSearchParam("limit", Number(event.target.value) || 1)}
                />
                <Button
                  className="h-14 rounded-full bg-cyan-400 px-6 text-slate-950 hover:bg-cyan-300"
                  disabled={!searchParams.query.trim() || submitting}
                  onClick={() => void handleSearch()}
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
                  ) : (
                    <Search className="size-4" data-icon="inline-start" />
                  )}
                  Submit Search
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "Databases", value: String(searchParams.selectedDbs.length), hint: "selected" },
              { label: "Mode", value: searchParams.mode, hint: "execution style" },
              { label: "Planner", value: searchParams.usePlanner ? "On" : "Off", hint: "query planning" },
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
              <p className="page-kicker">Databases</p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Select sources</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Choose one or more data sources for this queued search task.
              </p>
            </div>
            <Badge className="border-cyan-400/20 bg-cyan-400/10 text-cyan-200">
              {searchParams.selectedDbs.length} enabled
            </Badge>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {(meta?.all_databases ?? []).map((db) => {
              const active = searchParams.selectedDbs.includes(db);
              return (
                <button
                  key={db}
                  onClick={() => toggleDb(db)}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs transition ${
                    active
                      ? "border-cyan-400/15 bg-cyan-400/10 text-cyan-100"
                      : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200"
                  }`}
                >
                  <Database className="size-3.5" />
                  {db}
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel p-5 md:p-6">
          <p className="page-kicker">Task Settings</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Execution options</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            These settings apply only to the next task you submit.
          </p>

          <div className="mt-6 space-y-5">
            <div className="flex items-center justify-between gap-3 rounded-[18px] border border-white/8 bg-white/[0.03] px-4 py-3">
              <div>
                <p className="text-sm text-white">Use planner</p>
                <p className="mt-1 text-xs text-zinc-500">Split complex queries before execution.</p>
              </div>
              <Switch
                checked={searchParams.usePlanner}
                onCheckedChange={(value) => setSearchParam("usePlanner", value)}
              />
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-zinc-300">Mode</span>
                <Badge variant="outline" className="border-white/10 text-zinc-300">
                  {searchParams.mode}
                </Badge>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant={searchParams.mode === "multi" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSearchParam("mode", "multi")}
                >
                  Multi
                </Button>
                <Button
                  variant={searchParams.mode === "single" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSearchParam("mode", "single")}
                >
                  Single
                </Button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-zinc-300">Fetch concurrency</span>
                <Badge variant="outline" className="border-white/10 text-zinc-300">
                  {searchParams.fetchConcurrency}
                </Badge>
              </div>
              <Slider
                className="mt-4"
                min={1}
                max={30}
                step={1}
                value={[searchParams.fetchConcurrency]}
                onValueChange={(value) => setSearchParam("fetchConcurrency", value[0] ?? 15)}
              />
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-zinc-300">LLM concurrency</span>
                <Badge variant="outline" className="border-white/10 text-zinc-300">
                  {searchParams.llmConcurrency}
                </Badge>
              </div>
              <Slider
                className="mt-4"
                min={1}
                max={10}
                step={1}
                value={[searchParams.llmConcurrency]}
                onValueChange={(value) => setSearchParam("llmConcurrency", value[0] ?? 5)}
              />
            </div>
          </div>
        </div>
      </section>

      {pipeline.taskId ? (
        <div className="flex justify-end">
          <Link href={`/tasks?task=${encodeURIComponent(pipeline.taskId)}`}>
            <Button variant="outline" size="sm">
              <Sparkles className="size-3.5" data-icon="inline-start" />
              View in Task Center
            </Button>
          </Link>
        </div>
      ) : null}

      {showProgress ? <PipelineProgress /> : null}

      {pipeline.error ? (
        <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {pipeline.error}
        </div>
      ) : null}

      {pipeline.rows.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">Results</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Structured rows</h2>
              <p className="mt-2 text-sm text-zinc-400">
                {pipeline.rows.length} row(s) ready for export.
              </p>
            </div>
            <ExportMenu rows={pipeline.rows} />
          </div>

          <ResultsTable rows={pipeline.rows} onRowClick={(row) => setSelectedPaper(row)} />
        </section>
      ) : null}

      <PaperDetail paper={selectedPaper} open={!!selectedPaper} onClose={() => setSelectedPaper(null)} />
    </div>
  );
}
