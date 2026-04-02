"use client";

import type { CostEstimationResult } from "@/types";
import { DollarSign } from "lucide-react";

interface CostBreakdownProps {
  data: CostEstimationResult;
}

export default function CostBreakdown({ data }: CostBreakdownProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <DollarSign className="w-5 h-5 text-green-600" />
        <h3 className="font-semibold text-gray-900">
          Fabrication Cost Breakdown
        </h3>
      </div>
      <div className="p-6">
        <div className="space-y-3">
          {data.items.map((item, idx) => {
            const percentage = (item.cost_usd / data.total_cost_usd) * 100;
            return (
              <div key={idx}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-700">{item.process}</span>
                  <span className="font-medium text-gray-900">
                    ${item.cost_usd.toFixed(2)}
                  </span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full transition-all"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-6 pt-4 border-t border-gray-100 flex justify-between">
          <span className="font-semibold text-gray-900">Total</span>
          <span className="font-bold text-green-600">
            ${data.total_cost_usd.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
