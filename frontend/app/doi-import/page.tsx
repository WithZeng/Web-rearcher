"use client";

import { useCallback, useRef, useState } from "react";
import { FileText, Play, Upload } from "lucide-react";
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
  const doiColIdx = header.findIndex((h) => h.toLowerCase() === "doi" || h.toLowerCase() === "source_doi");

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

  return parseDois(text);
}

export default function DoiImportPage() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedPaper, setSelectedPaper] = useState<Record<string, unknown> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { pipeline, handlePipelineMessage, setPipelineField, resetPipeline } = useAppStore();

  const dois = parseDois(text);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
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
  }, []);

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
    <div className="app-page space-y-6">
      <section className="page-hero">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="page-kicker">DOI 导入</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-5xl">
              批量导入 DOI，快速处理已有文献。
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 md:text-base">
              支持手动粘贴 DOI 列表，或上传 CSV / TXT 文件进行批量导入。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { label: "识别 DOI", value: String(dois.length), hint: "当前待导入" },
              { label: "输入来源", value: fileName ? "文件" : "手动", hint: fileName || "文本框" },
              { label: "执行模式", value: "Multi", hint: "保持原有策略" },
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
          <p className="page-kicker">输入</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">粘贴 DOI 列表</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-400">
            每行一个 DOI，也支持直接粘贴 `https://doi.org/...` 链接。
          </p>

          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
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
                <p className="page-kicker">文件导入</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">上传 CSV / TXT 文件</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                  如果文件中包含 `doi` 或 `source_doi` 列，系统会自动识别并导入。
                </p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-300">
                  <FileText className="size-3.5" />
                  {fileName || "点击选择文件"}
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
            <p className="page-kicker">开始处理</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">导入并提取</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              点击后会按现有流程执行，并在下方显示进度和结果。
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
                已识别 <span className="ml-1 font-semibold text-zinc-100">{dois.length}</span> 个 DOI
              </span>
            </div>

            <Button
              onClick={handleSubmit}
              disabled={dois.length === 0 || pipeline.running}
              className="mt-5 h-12 rounded-full bg-cyan-400 px-5 text-slate-950 hover:bg-cyan-300"
            >
              <Play className="size-3.5" data-icon="inline-start" />
              开始导入并提取
            </Button>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {(pipeline.running || pipeline.currentStage === "complete") ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <PipelineProgress />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {pipeline.error ? (
        <p className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {pipeline.error}
        </p>
      ) : null}

      {pipeline.rows.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="page-kicker">结果</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">处理结果</h2>
              <p className="mt-2 text-sm text-zinc-400">共返回 {pipeline.rows.length} 条结构化记录。</p>
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
