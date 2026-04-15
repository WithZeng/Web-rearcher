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
  { label: "搜索", icon: Search, path: "/search" },
  { label: "DOI导入", icon: FileInput, path: "/doi-import" },
  { label: "PDF导入", icon: FileUp, path: "/pdf-import" },
  { label: "历史记录", icon: History, path: "/history" },
  { label: "统计", icon: BarChart3, path: "/stats" },
  { label: "设置", icon: Settings, path: "/settings" },
] as const;

const EXPANDED_WIDTH = 240;
const COLLAPSED_WIDTH = 60;

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  return (
    <motion.nav
      animate={{ width }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
      className="relative flex h-screen flex-col border-r border-white/[0.06] bg-zinc-950"
    >
      <div className="flex h-14 items-center gap-2.5 overflow-hidden px-4">
        <BookOpen className="size-5 shrink-0 text-blue-500" />
        <AnimatePresence mode="wait">
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.15 }}
              className="whitespace-nowrap text-sm font-semibold tracking-tight text-zinc-100"
            >
              文献检索助手
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="mx-3 h-px bg-white/[0.06]" />

      <div className="flex flex-1 flex-col gap-0.5 px-2 pt-3">
        <TooltipProvider>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.path || pathname.startsWith(item.path + "/");
            const Icon = item.icon;

            const linkContent = (
              <Link
                href={item.path}
                className={cn(
                  "group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                  active ? "text-zinc-50" : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {active && (
                  <motion.div
                    layoutId="sidebar-indicator"
                    className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-blue-500"
                    transition={{ type: "spring", stiffness: 350, damping: 30 }}
                  />
                )}
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    active ? "text-blue-500" : "text-zinc-600 group-hover:text-zinc-400",
                  )}
                />
                <AnimatePresence mode="wait">
                  {!collapsed && (
                    <motion.span
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden whitespace-nowrap"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.path}>
                  <TooltipTrigger render={<div />}>
                    {linkContent}
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return <div key={item.path}>{linkContent}</div>;
          })}
        </TooltipProvider>
      </div>

      <div className="px-2 pb-3">
        <div className="mx-1 mb-2 h-px bg-white/[0.06]" />
        <button
          onClick={() => setCollapsed((current) => !current)}
          className="flex h-9 w-full items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-400"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </div>
    </motion.nav>
  );
}
