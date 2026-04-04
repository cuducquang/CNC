"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Upload,
  History,
  Bot,
} from "lucide-react";
import Image from "next/image";

const navItems = [
  { href: "/", label: "New Analysis", icon: Upload },
  { href: "/history", label: "History", icon: History },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:border-r bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className="flex items-center gap-3 px-6 h-16 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <Image src="/logo.svg" alt="CNC Costing AI" width={18} height={18} className="invert" />
        </div>
        <div>
          <div className="font-semibold text-sm">CNC Costing AI</div>
          <div className="text-xs text-sidebar-foreground/60">Agentic Pipeline</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-sidebar-accent/30">
          <Bot className="w-4 h-4 text-sidebar-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">Agent Model</div>
          </div>
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
        </div>
      </div>
    </aside>
  );
}
