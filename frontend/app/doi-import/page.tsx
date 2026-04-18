"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Play, Upload } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { PipelineProgress } from "@/components/pipeline-progress";
import { ResultsTable } from "@/components/results-table";
import { ExportMenu } from "@/components/export-menu";
import { PaperDetail } from "@/components/paper-detail";
import { api } from "@/lib/api";
import { connectPipeline } from "@/lib/ws";
import { useAppStore } from "@/lib/store";

function parseDois(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .map((value) => value.replace(/^https?:\/\/doi\.org\//i, ""))
    .filter((value) => value.includes("/"));
}

function extractDoisFromCSV(text: string): string[] {
  const lines = text.trim().split("\n");
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
  const doiColIdx = header.findIndex((value) => value.toLowerCase() === "doi" || value.toLowerCase() === "source_doi");

  if (doiColIdx !== -1) {
    return lines
      .slice(1)
      .map((line) => {
        const cols = line.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
        return cols[doiColIdx] ?? "";
      })
      .map((value) => value.replace(/^https?:\/\/doi\.org\//i, ""))
      .filter((value) => value.includes("/"));
  }

  return parseDois(text);
}

export default function DoiImportPage() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const wsCloseRef = useRef<(() => void) | null>(null);

  const { pipeline, handlePipelineMessage, setPipelineField, resetPipeline } = useAppStore();

  const dois = parseDois(text);

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

  const handleFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      const extracted = extractDoisFromCSV(content);
      setText(extracted.join("\n"));
    };
    reader.readAsText(file);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (dois.length === 0 || submitting) return;

    resetPipeline();
    setSubmitting(true);

    try {
      const result = await api.pipeline.doi({
        dois,
        mode: "multi",
        fetch_concurrency: 20,
        llm_concurrency: 10,
      });

      setPipelineField("taskId", result.task_id);
      setPipelineField("state", result.state);
      setPipelineField("queuePosition", result.queue_position ?? null);
      setPipelineField("running", result.state === "running");
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
      setPipelineField("error", error instanceof Error ? error.message : "DOI import failed");
      setPipelineField("running", false);
    } finally {
      setSubmitting(false);
    }
  }, [dois, submitting, resetPipeline, setPipelineField, handlePipelineMessage]);

  return (
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="page-kicker">DOI Import</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              Paste DOI lists and queue them without waiting for the current task.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              Submit another DOI import any time. It will either start immediately or wait in the shared queue.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "Detected DOIs", value: String(dois.length), hint: "ready to import" },
              { label: "Input source", value: fileName ? "File" : "Manual", hint: fileName || "text area" },
              { label: "Execution mode", value: "Multi", hint: "same as before" },
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

      <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="panel p-5 md:p-6">
          <p className="page-kicker">Input</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Paste DOI values</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            One DOI per line also works. Full `https://doi.org/...` links are accepted too.
          </p>

          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setFileName(null);
            }}
            placeholder={"10.1038/s41586-023-06600-9\n10.1126/science.adg7879\n10.1016/j.cell.2023.12.028"}
            className="mt-5 h-72 w-full resize-none rounded-[26px] border border-white/10 bg-black/20 px-4 py-4 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-300/30 focus:outline-none focus:ring-1 focus:ring-cyan-300/20"
          />
        </div>

        <div className="space-y-6">
          <div
            onClick={() => fileRef.current?.click()}
            className="panel cursor-pointer p-5 transition hover:border-cyan-300/20 hover:bg-cyan-400/[0.04]"
          >
            <div className="flex items-start gap-4">
              <div className="flex size-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                <Upload className="size-5" />
              </div>
              <div>
                <p className="page-kicker">CSV / TXT</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Import from file</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  If the file contains a `doi` or `source_doi` column, the importer will extract it automatically.
                </p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-300">
                  <FileText className="size-3.5" />
                  {fileName || "Click to choose a file"}
                </div>
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              onChange={handleFile}
              className="hidden"
            />
          </div>

          <div className="panel p-5">
            <p className="page-kicker">Submit</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Queue DOI import task</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              The task will either start immediately or enter the queue. You can keep submitting other work afterward.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
                Detected <span className="ml-1 font-semibold text-zinc-100">{dois.length}</span> DOI(s)
              </span>
            </div>

            <Button
              onClick={() => void handleSubmit()}
              disabled={dois.length === 0 || submitting}
              className="mt-5 h-12 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
              ) : (
                <Play className="size-3.5" data-icon="inline-start" />
              )}
              Submit DOI Task
            </Button>
          </div>
        </div>
      </section>

      {pipeline.taskId ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex justify-end">
            <Link href={`/tasks?task=${encodeURIComponent(pipeline.taskId)}`}>
              <Button variant="outline" size="sm">
                <Play className="size-3.5" data-icon="inline-start" />
                View in Task Center
              </Button>
            </Link>
          </div>
        </motion.div>
      ) : null}

      {(pipeline.taskId || pipeline.rows.length > 0) ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <PipelineProgress />
        </motion.div>
      ) : null}

      {pipeline.error ? (
        <p className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {pipeline.error}
        </p>
      ) : null}

      {pipeline.rows.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">Results</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Processed rows</h2>
              <p className="mt-2 text-sm text-zinc-400">
                {pipeline.rows.length} structured row(s) ready for export.
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
