"use client";

import type { FeatureRecognitionResult } from "@/types";
import { Layers } from "lucide-react";

interface FeatureListProps {
  data: FeatureRecognitionResult;
}

export default function FeatureList({ data }: FeatureListProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <Layers className="w-5 h-5 text-purple-600" />
        <h3 className="font-semibold text-gray-900">Recognized Features</h3>
        <span className="ml-auto text-sm text-gray-500">
          {data.features.length} features
        </span>
      </div>
      <div className="divide-y divide-gray-100">
        {data.features.map((feature) => (
          <div key={feature.id} className="px-6 py-4">
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-purple-50 text-purple-700 text-xs font-bold shrink-0">
                {feature.id}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900">{feature.name}</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {feature.description}
                </p>
                {feature.dimensions &&
                  Object.keys(feature.dimensions).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(feature.dimensions).map(([key, val]) => (
                        <span
                          key={key}
                          className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded"
                        >
                          {key}: {val}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded-full">
                {feature.type}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
