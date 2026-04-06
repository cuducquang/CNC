"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Upload, History } from "lucide-react";

const navItems = [
  { href: "/", label: "New Analysis", icon: Upload },
  { href: "/history", label: "History", icon: History },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-56 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary shrink-0">
          <span className="text-primary-foreground font-bold text-[11px] font-mono leading-none">CNC</span>
        </div>
        <div className="leading-none min-w-0">
          <div className="text-[13px] font-semibold tracking-tight truncate">CNC Costing AI</div>
          <div className="text-[10px] text-sidebar-foreground/40 mt-0.5 font-mono">v1.0</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {navItems.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 py-2 rounded-md text-[13px] font-medium transition-all border-l-2 pl-[10px] pr-3",
                isActive
                  ? "border-primary bg-primary/8 text-primary"
                  : "border-transparent text-muted-foreground/60 hover:text-foreground hover:bg-accent/40"
              )}
            >
              <item.icon className="w-3.5 h-3.5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer status */}
      <div className="px-3 py-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 status-online shrink-0" />
          <span className="text-[11px] text-sidebar-foreground/50 font-mono">agent · ready</span>
        </div>
      </div>
    </aside>
  );
}
