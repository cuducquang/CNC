"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Upload, History, Menu } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { UserMenu } from "@/components/auth/user-menu";

const navItems = [
  { href: "/", label: "New Analysis", icon: Upload },
  { href: "/history", label: "History", icon: History },
];

export function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex items-center h-14 px-4 lg:px-6">
        {/* Mobile brand */}
        <div className="flex items-center gap-2 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu className="w-5 h-5" />
          </Button>
          <Image src="/logo.svg" alt="CNC Costing AI" width={20} height={20} />
          <span className="font-semibold text-sm">CNC Costing AI</span>
        </div>

        {/* Desktop: page title */}
        <div className="hidden lg:block">
          <h1 className="text-sm font-semibold">
            {pathname === "/" && "New Analysis"}
            {pathname === "/history" && "Analysis History"}
            {pathname.startsWith("/analysis/") && "Analysis Results"}
          </h1>
        </div>

        <div className="flex-1" />

        {/* Status indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mr-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Agent Online
        </div>

        <UserMenu />
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <nav className="lg:hidden border-t px-4 py-2 space-y-1">
          {navItems.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
