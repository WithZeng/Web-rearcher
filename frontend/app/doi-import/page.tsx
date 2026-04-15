"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, Play, FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
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
    .map((s) => s.trim())
    .map((s) => s.replace(/^https?:\/\/doi\.org\//i, ""))
    .filter((s) => s.includes("/"));
}

function extractDoisFromCSV(text: string): string[] {
  const lines = text.trim().split("\n");
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const doiColIdx = header.findIndex(
    (h) =>
      h.toLowerCase() === "doi" ||
      h.toLowerCase() === "source_doi",
  );

  if (doiColIdx !== -1) {
    return lines
      .slice(1)
      .map((line) => {
        const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        return cols[doiColIdx] ?? "";
      })
      .map((s) => s.replace(/^https?:\/\/doi\.org\//i, ""))
      .filter((s) => s.includes("/"));
  }

  // Single-column fallback: treat every line as a DOI
  return parseDois(text);
}

export default function DoiImportPage() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { pipeline, handlePipelineMessage, setPipelineField, resetPipeline } =
    useAppStore();

  const [selectedPaper, setSelectedPaper] = useState<Record<
    string,
    unknown
  > | null>(null);

  const dois = parseDois(text);

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        const extracted = extractDoisFromCSV(content);
        setText(extracted.join("\n"));
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (dois.length === 0) return;
    resetPipeline();
    setPipelineField("running", true);
    setPipelineField("startedAt", Date.now());

    try {
      const { task_id } = await api.pipeline.doi({
        dois,
        mode: "multi",
        fetch_concurrency: 20,
        llm_concurrency: 10,
      });
      setPipelineField("taskId", task_id);
      connectPipeline(task_id, handlePipelineMessage);
    } catch (err) {
      setPipelineField("error", String(err));
      setPipelineField("running", false);
    }
  }, [dois, resetPipeline, setPipelineField, handlePipelineMessage]);

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
          DOI 批量导入
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          粘贴 DOI 列表（每行一个）或上传 CSV 文件
        </p>
      </div>

      {/* Textarea */}
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setFileName(null);
        }}
        placeholder={
          "10.1038/s41586-023-06600-9\n10.1126/science.adg7879\n10.1016/j.cell.2023.12.028"
        }
        className="h-48 w-full resize-none rounded-lg border border-white/[0.06] bg-zinc-900/50 px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500/40 focus:outline-none focus:ring-1 focus:ring-blue-500/20"
      />

      {/* File upload */}
      <div
        onClick={() => fileRef.current?.click()}
        className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-white/[0.08] px-4 py-3 transition-colors hover:border-white/[0.15] hover:bg-white/[0.02]"
      >
        <Upload className="size-4 text-zinc-500" />
        <span className="text-sm text-zinc-400">
          {fileName ? (
            <>
              <FileText className="mr-1.5 inline size-3.5" />
              {fileName}
            </>
          ) : (
            "点击上传 CSV / TXT 文件"
          )}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          onChange={handleFile}
          className="hidden"
        />
      </div>

      {/* DOI count + submit */}
      <div className="flex items-center gap-4">
        <AnimatePresence>
          {dois.length > 0 && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              className="text-sm text-zinc-400"
            >
              已识别{" "}
              <span className="font-medium text-zinc-200">{dois.length}</span>{" "}
              个 DOI
            </motion.span>
          )}
        </AnimatePresence>
        <div className="flex-1" />
        <Button
          onClick={handleSubmit}
          disabled={dois.length === 0 || pipeline.running}
        >
          <Play className="size-3.5" data-icon="inline-start" />
          开始导入并提取
        </Button>
      </div>

      {/* Pipeline progress */}
      <AnimatePresence>
        {(pipeline.running || pipeline.currentStage === "complete") && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <PipelineProgress />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {pipeline.error && (
        <p className="text-sm text-red-400">{pipeline.error}</p>
      )}

      {/* Results */}
      {pipeline.rows.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">
              共 {pipeline.rows.length} 条结果
            </span>
            <ExportMenu rows={pipeline.rows} />
          </div>
          <ResultsTable
            rows={pipeline.rows}
            onRowClick={(row) => setSelectedPaper(row)}
          />
        </div>
      )}

      <PaperDetail
        paper={selectedPaper}
        open={!!selectedPaper}
        onClose={() => setSelectedPaper(null)}
      />
    </div>
  );
}
