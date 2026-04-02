"use client";

import type { ProcessMappingResult } from "@/types";
import { Settings } from "lucide-react";

interface ProcessListProps {
  data: ProcessMappingResult;
}

const categoryColors: Record<string, string> = {
  setup: "bg-yellow-100 text-yellow-800",
  milling: "bg-blue-100 text-blue-800",
  drilling: "bg-orange-100 text-orange-800",
  threading: "bg-red-100 text-red-800",
  finishing: "bg-green-100 text-green-800",
  other: "bg-gray-100 text-gray-800",
};

export default function ProcessList({ data }: ProcessListProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <Settings className="w-5 h-5 text-orange-600" />
        <h3 className="font-semibold text-gray-900">Manufacturing Processes</h3>
        <span className="ml-auto text-sm text-gray-500">
          {data.processes.length} processes
        </span>
      </div>
      <div className="divide-y divide-gray-100">
        {data.processes.map((process, idx) => (
          <div key={idx} className="px-6 py-3 flex items-center gap-3">
            <span className="text-sm font-mono text-gray-400 w-6">
              {idx + 1}.
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">
                {process.name}
              </p>
              <p className="text-xs text-gray-500">{process.description}</p>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                categoryColors[process.category] || categoryColors.other
              }`}
            >
              {process.category}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
