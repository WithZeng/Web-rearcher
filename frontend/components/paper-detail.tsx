"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { QualityBadge } from "@/components/quality-badge";
import { useAppStore } from "@/lib/store";

interface PaperDetailProps {
  paper: Record<string, unknown> | null;
  open: boolean;
  onClose: () => void;
}

const REVIEW_COLORS: Record<string, string> = {
  ok: "text-emerald-400",
  suspicious: "text-amber-300",
  low_quality: "text-rose-400",
};

const REVIEW_LABELS: Record<string, string> = {
  ok: "通过",
  suspicious: "待复核",
  low_quality: "低质量",
};

export function PaperDetail({ paper, open, onClose }: PaperDetailProps) {
  const meta = useAppStore((s) => s.meta);

  if (!paper) return null;

  const title = String(paper.source_title ?? paper.title ?? "Untitled");
  const doi = String(paper.source_doi ?? "");
  const quality = Number(paper._data_quality);
  const review = String(paper._review ?? "");
  const qualityLabel = String(paper._quality_label ?? "");

  const fields = meta?.fields ?? [];
  const labels = meta?.field_labels ?? {};

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-[560px] border-l border-white/10 bg-[linear-gradient(180deg,rgba(7,10,18,0.98),rgba(9,12,20,0.96))] sm:max-w-xl"
      >
        <SheetHeader>
          <div className="space-y-4">
            <div>
              <p className="page-kicker">Paper Detail</p>
              <SheetTitle className="mt-3 text-left text-xl leading-snug text-white">
                {title}
              </SheetTitle>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!Number.isNaN(quality) ? (
                <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
                  数据质量
                  <span
                    className={`ml-2 font-semibold ${
                      quality >= 0.7
                        ? "text-emerald-400"
                        : quality >= 0.4
                          ? "text-amber-300"
                          : "text-rose-400"
                    }`}
                  >
                    {Math.round(quality * 100)}%
                  </span>
                </span>
              ) : null}
              {review ? (
                <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">
                  复核状态
                  <span className={`ml-2 font-semibold ${REVIEW_COLORS[review] ?? "text-zinc-400"}`}>
                    {REVIEW_LABELS[review] ?? review}
                  </span>
                </span>
              ) : null}
              {qualityLabel ? <QualityBadge label={qualityLabel} /> : null}
            </div>

            {doi ? (
              <a
                href={`https://doi.org/${doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-400/15 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-200 transition hover:bg-cyan-400/15"
              >
                {doi}
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </div>
        </SheetHeader>

        <ScrollArea className="mt-6 flex-1 px-1 pb-6">
          <Separator className="mb-5 bg-white/8" />

          <AnimatePresence>
            <dl className="space-y-4">
              {fields.map((field, i) => {
                const value = paper[field];
                const display =
                  value == null || value === ""
                    ? "--"
                    : typeof value === "object"
                      ? JSON.stringify(value, null, 2)
                      : String(value);
                const isEmpty = value == null || value === "";

                return (
                  <motion.div
                    key={field}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02, duration: 0.18 }}
                    className="rounded-[22px] border border-white/8 bg-white/[0.025] px-4 py-4"
                  >
                    <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                      {labels[field] ?? field}
                    </dt>
                    <dd
                      className={`mt-2 break-words whitespace-pre-wrap text-sm leading-6 ${
                        isEmpty ? "text-zinc-600" : "text-zinc-200"
                      }`}
                    >
                      {display}
                    </dd>
                  </motion.div>
                );
              })}
            </dl>
          </AnimatePresence>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
