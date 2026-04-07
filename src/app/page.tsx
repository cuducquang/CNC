"use client";

import { useRouter } from "next/navigation";
import { ApproachSelector } from "@/components/ui/ApproachSelector";
import { Cpu, Sparkles } from "lucide-react";

/**
 * Landing page — approach selection.
 *
 * Clicking a card navigates to /analyze?approach=1 or /analyze?approach=2.
 */
export default function LandingPage() {
  const router = useRouter();

  const handleSelect = (approach: 1 | 2) => {
    router.push(`/analyze?approach=${approach}`);
  };

  return (
    <div className="space-y-10 py-4 max-w-3xl mx-auto">
      {/* Hero */}
      <div className="text-center space-y-5">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl brand-gradient shadow-[0_4px_14px_0_oklch(0.60_0.175_68_/_0.35)] mx-auto">
          <Cpu className="w-7 h-7 text-white" />
        </div>

        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/8 border border-primary/20 px-4 py-1.5">
            <Sparkles className="w-3 h-3 text-primary" />
            <span className="text-[11px] font-bold text-primary/80 uppercase tracking-widest">
              CNC Costing AI
            </span>
          </div>

          <h1 className="text-[32px] font-bold tracking-tight text-foreground leading-tight">
            AI-Powered Manufacturing<br className="hidden sm:block" /> Cost Estimator
          </h1>

          <p className="text-[14px] text-muted-foreground max-w-md mx-auto leading-relaxed">
            Upload a 2D engineering drawing and a 3D STEP file. Choose your analysis approach below to get features, operations, cycle time, and a precise cost estimate.
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-3 text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest">
            Select Approach
          </span>
        </div>
      </div>

      {/* Approach cards */}
      <ApproachSelector onSelect={handleSelect} />

      {/* Footer note */}
      <p className="text-center text-[11.5px] text-muted-foreground/50 pb-2">
        Both approaches use the same file upload flow and produce the same output format. Approach 2 requires the FreeCAD service running on port 8001.
      </p>
    </div>
  );
}
