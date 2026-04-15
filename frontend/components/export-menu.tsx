"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

interface ExportMenuProps {
  rows: Record<string, unknown>[];
}

const FORMATS = [
  { key: "csv", label: "CSV", ext: "csv" },
  { key: "excel", label: "Excel (.xlsx)", ext: "xlsx" },
  { key: "json", label: "JSON", ext: "json" },
  { key: "bibtex", label: "BibTeX", ext: "bib" },
] as const;

export function ExportMenu({ rows }: ExportMenuProps) {
  const handleExport = async (format: string, ext: string) => {
    try {
      const blob = await api.export.download(format, rows);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `results.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={rows.length === 0}>
            <Download className="size-3.5" data-icon="inline-start" />
            导出
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f.key} onClick={() => handleExport(f.key, f.ext)}>
            {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
