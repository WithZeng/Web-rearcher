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
    <div className="relative min-h-screen bg-transparent text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-y-0 left-0 w-[28rem] bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.14),transparent_68%)]" />
        <div className="absolute right-[-8rem] top-[-6rem] h-72 w-72 rounded-full bg-cyan-400/8 blur-3xl" />
        <div className="absolute bottom-[-10rem] left-1/3 h-80 w-80 rounded-full bg-sky-500/6 blur-3xl" />
      </div>

      <div className="relative flex min-h-screen">
        <Sidebar />

        <main className="relative flex-1 pl-[92px] md:pl-[286px]">
          <div className="min-h-screen px-2 py-2 md:px-3 md:py-3">
          <div className="min-h-[calc(100vh-1rem)] rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(7,10,18,0.86),rgba(8,12,20,0.78))] shadow-[0_36px_140px_rgba(0,0,0,0.42)] backdrop-blur-xl">
            <AnimatePresence mode="wait">
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="min-h-[calc(100vh-1rem)]"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
          </div>
        </main>
      </div>
    </div>
  );
}
