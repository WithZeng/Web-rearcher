"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const setMeta = useAppStore((s) => s.setMeta);
  const pathname = usePathname();

  useEffect(() => {
    api.meta().then(setMeta).catch(console.error);
  }, [setMeta]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="h-full"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
