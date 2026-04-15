"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface QualityBadgeProps {
  label: string;
}

const labelConfig: Record<string, { text: string; className: string }> = {
  high_value: {
    text: "高质量",
    className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  },
  medium_value: {
    text: "中等",
    className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  },
  low_value: {
    text: "低质量",
    className: "bg-red-500/20 text-red-400 border-red-500/30",
  },
};

export function QualityBadge({ label }: QualityBadgeProps) {
  const config = labelConfig[label] ?? {
    text: label || "未知",
    className: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  };

  return (
    <Badge variant="outline" className={cn("text-[11px]", config.className)}>
      {config.text}
    </Badge>
  );
}
