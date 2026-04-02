"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Timer, DollarSign, Layers, Wrench } from "lucide-react";

interface SummaryCardsProps {
  totalMinutes: number;
  totalUsd: number;
  featureCount: number;
  operationCount: number;
}

export function SummaryCards({ totalMinutes, totalUsd, featureCount, operationCount }: SummaryCardsProps) {
  const cards = [
    { label: "Cycle Time", value: `${totalMinutes.toFixed(1)} min`, icon: Timer, color: "text-cyan-600" },
    { label: "Total Cost", value: `$${totalUsd.toFixed(2)}`, icon: DollarSign, color: "text-emerald-600" },
    { label: "Features", value: String(featureCount), icon: Layers, color: "text-blue-600" },
    { label: "Operations", value: String(operationCount), icon: Wrench, color: "text-orange-600" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.label} className="py-4">
          <CardContent className="flex items-center gap-3 px-4">
            <div className={`${c.color}`}>
              <c.icon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-lg font-bold">{c.value}</div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
