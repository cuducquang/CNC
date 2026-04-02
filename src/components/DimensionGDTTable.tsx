"use client";

import type { DimensionGDTResult } from "@/types";
import { Ruler } from "lucide-react";

interface DimensionGDTTableProps {
  data: DimensionGDTResult;
}

export default function DimensionGDTTable({ data }: DimensionGDTTableProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <Ruler className="w-5 h-5 text-teal-600" />
        <h3 className="font-semibold text-gray-900">
          Dimensions & GD&T
        </h3>
      </div>
      <div className="p-6 space-y-6">
        {/* Dimensions Table */}
        {data.dimensions.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              Dimensions
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Feature
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Nominal
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Tol +
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Tol -
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Unit
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.dimensions.map((dim, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 text-gray-900">
                        {dim.feature}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-900">
                        {dim.nominal}
                      </td>
                      <td className="px-3 py-2 font-mono text-green-700">
                        {dim.tolerance_plus ? `+${dim.tolerance_plus}` : "-"}
                      </td>
                      <td className="px-3 py-2 font-mono text-red-700">
                        {dim.tolerance_minus ? `-${dim.tolerance_minus}` : "-"}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{dim.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* GD&T Callouts Table */}
        {data.gdt_callouts.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              GD&T Callouts
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Feature
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Type
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Value
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      Datum
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.gdt_callouts.map((gdt, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 text-gray-900">
                        {gdt.feature}
                      </td>
                      <td className="px-3 py-2">
                        <span className="bg-teal-50 text-teal-700 px-2 py-0.5 rounded text-xs">
                          {gdt.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-900">
                        {gdt.value}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {gdt.datum || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
