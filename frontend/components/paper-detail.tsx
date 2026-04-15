"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  suspicious: "text-yellow-400",
  low_quality: "text-red-400",
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
      <SheetContent side="right" className="w-[500px] sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-left text-base leading-snug">
            {title}
          </SheetTitle>
          {doi && (
            <a
              href={`https://doi.org/${doi}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              {doi}
              <ExternalLink className="size-3" />
            </a>
          )}
        </SheetHeader>

        <ScrollArea className="mt-4 flex-1 px-1 pb-6">
          {/* Quality metrics */}
          <div className="mb-4 flex items-center gap-4">
            {!isNaN(quality) && (
              <span className="text-xs text-zinc-400">
                数据质量{" "}
                <span
                  className={`font-medium ${
                    quality >= 0.7
                      ? "text-emerald-400"
                      : quality >= 0.4
                        ? "text-yellow-400"
                        : "text-red-400"
                  }`}
                >
                  {Math.round(quality * 100)}%
                </span>
              </span>
            )}
            {review && (
              <span className="text-xs text-zinc-400">
                审查{" "}
                <span className={`font-medium ${REVIEW_COLORS[review] ?? "text-zinc-400"}`}>
                  {review}
                </span>
              </span>
            )}
            {qualityLabel && <QualityBadge label={qualityLabel} />}
          </div>

          <Separator className="mb-4" />

          {/* Fields */}
          <AnimatePresence>
            <dl className="space-y-3">
              {fields.map((field, i) => {
                const value = paper[field];
                const display =
                  value == null || value === ""
                    ? "—"
                    : typeof value === "object"
                      ? JSON.stringify(value, null, 2)
                      : String(value);
                const isEmpty = value == null || value === "";

                return (
                  <motion.div
                    key={field}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03, duration: 0.2 }}
                    className="space-y-0.5"
                  >
                    <dt className="text-[11px] font-medium text-zinc-500">
                      {labels[field] ?? field}
                    </dt>
                    <dd
                      className={`break-words text-sm whitespace-pre-wrap ${
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
