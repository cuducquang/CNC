"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Upload, History, Menu } from "lucide-react";
import { useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";

const navItems = [
  { href: "/", label: "New Analysis", icon: Upload },
  { href: "/history", label: "History", icon: History },
];

const PAGE_TITLES: Record<string, string> = {
  "/": "New Analysis",
  "/history": "Analysis History",
};

export function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const title = PAGE_TITLES[pathname] ?? (pathname.startsWith("/analysis/") ? "Analysis Results" : "");

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md h-14">
      <div className="flex items-center h-full px-4 lg:px-6 gap-4">
        {/* Mobile brand */}
        <div className="flex items-center gap-2 lg:hidden">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMobileOpen(!mobileOpen)}>
            <Menu className="w-4 h-4" />
          </Button>
          <div className="flex items-center justify-center w-6 h-6 rounded bg-primary shrink-0">
            <span className="text-primary-foreground font-bold text-[9px] font-mono leading-none">CNC</span>
          </div>
          <span className="font-semibold text-sm">CNC Costing AI</span>
        </div>

        {/* Desktop: page title */}
        <div className="hidden lg:block">
          <span className="text-[13px] font-medium text-muted-foreground">{title}</span>
        </div>

        <div className="flex-1" />

        {/* Online status */}
        <div className="hidden sm:flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/50">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 status-online" />
          <span>online</span>
        </div>

        <UserMenu />
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <nav className="lg:hidden border-t border-border px-3 py-2 space-y-0.5 bg-sidebar">
          {navItems.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <item.icon className="w-3.5 h-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
