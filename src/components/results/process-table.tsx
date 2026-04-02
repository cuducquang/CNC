"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface Process {
  id: string;
  label: string;
  operation: string;
  tool: { type: string; diameter: number; material: string };
  params: { spindle_rpm: number; feed_rate_ipm: number };
  toolpath_distance_in: number;
}

export function ProcessTable({ processes }: { processes: Process[] }) {
  if (!processes.length) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Operation</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">Feed (IPM)</TableHead>
          <TableHead className="text-right">Distance (in)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {processes.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="text-sm">{p.label}</TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">{p.tool.material}</Badge>
                <span className="text-xs text-muted-foreground">
                  {p.tool.diameter.toFixed(3)}&quot; {p.tool.type}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{p.params.spindle_rpm}</TableCell>
            <TableCell className="text-right font-mono text-xs">{p.params.feed_rate_ipm.toFixed(1)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{p.toolpath_distance_in.toFixed(3)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
