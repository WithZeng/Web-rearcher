"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileInput,
  FileUp,
  History,
  Search,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { label: "智能检索", icon: Search, path: "/search" },
  { label: "DOI 导入", icon: FileInput, path: "/doi-import" },
  { label: "PDF 导入", icon: FileUp, path: "/pdf-import" },
  { label: "历史记录", icon: History, path: "/history" },
  { label: "统计分析", icon: BarChart3, path: "/stats" },
  { label: "系统设置", icon: Settings, path: "/settings" },
] as const;

const EXPANDED_WIDTH = 280;
const COLLAPSED_WIDTH = 86;

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  return (
    <motion.nav
      animate={{ width }}
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
      className="fixed left-0 top-0 z-30 flex h-screen shrink-0 flex-col border-r border-white/8 bg-[linear-gradient(180deg,rgba(8,12,20,0.98),rgba(7,9,15,0.95))] px-3 py-3"
    >
      <div className="panel-muted overflow-hidden rounded-[28px] border-white/8 bg-white/[0.035]">
        <div className="flex items-start gap-3 px-4 py-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
            <BookOpen className="size-5" />
          </div>
          <AnimatePresence mode="wait">
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.16 }}
                className="min-w-0"
              >
                <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/70">
                  Research Cockpit
                </p>
                <p className="mt-2 text-sm font-semibold tracking-tight text-zinc-100">
                  Web Researcher
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">
                  统一检索、提取、审查和整理文献结果。
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-white/6 px-4 py-3"
            >
              <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">
                  Workflow
                </p>
                <p className="mt-2 text-sm text-zinc-300">
                  从查询输入到表格导出，都在同一条工作流里完成。
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-4 flex-1">
        <TooltipProvider>
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.path || pathname.startsWith(item.path + "/");
              const Icon = item.icon;

              const linkContent = (
                <Link
                  href={item.path}
                  className={cn(
                    "group relative flex min-h-12 items-center gap-3 overflow-hidden rounded-2xl px-3 py-2.5 transition-all duration-200",
                    active
                      ? "bg-cyan-400/10 text-white shadow-[0_10px_30px_rgba(34,211,238,0.12)]"
                      : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200",
                  )}
                >
                  {active ? (
                    <motion.div
                      layoutId="sidebar-indicator"
                      className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-cyan-300"
                      transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl border transition-colors",
                      active
                        ? "border-cyan-300/20 bg-cyan-300/12 text-cyan-200"
                        : "border-white/6 bg-white/[0.03] text-zinc-500 group-hover:text-zinc-200",
                    )}
                  >
                    <Icon className="size-4" />
                  </div>
                  <AnimatePresence mode="wait">
                    {!collapsed && (
                      <motion.div
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.16 }}
                        className="min-w-0 overflow-hidden"
                      >
                        <p className="truncate text-sm font-medium">{item.label}</p>
                        <p className="truncate text-xs text-zinc-500">
                          {item.path === "/search" && "检索与抽取主工作台"}
                          {item.path === "/doi-import" && "批量导入 DOI 列表"}
                          {item.path === "/pdf-import" && "上传本地 PDF 文件"}
                          {item.path === "/history" && "查看历史任务与合并结果"}
                          {item.path === "/stats" && "总览任务与质量分布"}
                          {item.path === "/settings" && "配置模型与数据源"}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Link>
              );

              if (collapsed) {
                return (
                  <Tooltip key={item.path}>
                    <TooltipTrigger render={<div />}>{linkContent}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return <div key={item.path}>{linkContent}</div>;
            })}
          </div>
        </TooltipProvider>
      </div>

      <div className="mt-4 space-y-3">
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-3"
            >
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">
                Tip
              </p>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                页面样式已统一为工作台模式，功能入口和原有流程保持不变。
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <button
        onClick={() => setCollapsed((current) => !current)}
        className="absolute -right-4 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-cyan-400/20 bg-[#0b1220] text-cyan-200 shadow-[0_10px_30px_rgba(0,0,0,0.35)] transition hover:scale-105 hover:bg-[#0f1727]"
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        title={collapsed ? "展开侧栏" : "收起侧栏"}
      >
        {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
      </button>
    </motion.nav>
  );
}
