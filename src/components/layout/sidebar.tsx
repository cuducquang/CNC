"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, History, Cpu, Brain, Wrench } from "lucide-react";
import { Suspense } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** pathname to match (without query) */
  matchPath?: string;
  /** query param value to match */
  matchApproach?: string;
}

const navItems: NavItem[] = [
  { href: "/",                   label: "Home",                icon: LayoutDashboard },
  { href: "/analyze?approach=1", label: "Approach 1 — AI",     icon: Brain,  matchPath: "/analyze", matchApproach: "1" },
  { href: "/analyze?approach=2", label: "Approach 2 — FreeCAD",icon: Wrench, matchPath: "/analyze", matchApproach: "2" },
  { href: "/history",            label: "History",              icon: History },
];

function SidebarNav() {
  const pathname    = usePathname();
  const searchParams = useSearchParams();
  const approach    = searchParams.get("approach");

  return (
    <nav className="flex-1 px-3 py-4 space-y-0.5">
      <p className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
        Menu
      </p>
      {navItems.map((item) => {
        let isActive: boolean;
        if (item.matchPath) {
          isActive = pathname === item.matchPath && approach === item.matchApproach;
        } else if (item.href === "/") {
          isActive = pathname === "/";
        } else {
          isActive = pathname.startsWith(item.href);
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-[13px] font-medium transition-all",
              isActive
                ? "bg-primary/8 text-primary"
                : "text-muted-foreground/65 hover:text-foreground hover:bg-accent/60"
            )}
          >
            <div className={cn(
              "flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors",
              isActive ? "bg-primary/15 text-primary" : "bg-muted/70 text-muted-foreground"
            )}>
              <item.icon className="w-3.5 h-3.5" />
            </div>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-60 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 h-[60px] border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg brand-gradient shrink-0">
          <Cpu className="w-4 h-4 text-white" />
        </div>
        <div className="leading-none min-w-0">
          <div className="text-[13.5px] font-semibold tracking-tight">CNC Costing AI</div>
          <div className="text-[10px] text-sidebar-foreground/40 mt-0.5 font-mono">v1.0 · AI Manufacturing</div>
        </div>
      </div>

      {/* Navigation — wrapped in Suspense because useSearchParams requires it */}
      <Suspense fallback={<div className="flex-1" />}>
        <SidebarNav />
      </Suspense>

      {/* Status footer */}
      <div className="px-3 pb-4 border-t border-sidebar-border pt-3">
        <div className="flex items-center gap-2.5 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 status-online shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-emerald-700">Pipeline Ready</div>
            <div className="text-[10px] text-emerald-600/60 font-mono truncate">Qwen3-VL · vLLM</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
