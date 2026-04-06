"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { Upload, FileBox, FileImage, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileDropzoneProps {
  label: string;
  description: string;
  accept: Record<string, string[]>;
  file: File | null;
  onFileSelect: (file: File | null) => void;
  icon: "3d" | "2d";
  required?: boolean;
}

export function FileDropzone({ label, description, accept, file, onFileSelect, icon }: FileDropzoneProps) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length > 0) onFileSelect(accepted[0]);
    },
    [onFileSelect]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple: false,
  });

  const Icon = icon === "3d" ? FileBox : FileImage;

  if (file) {
    return (
      <div className="relative flex items-center gap-3.5 rounded-xl border border-primary/25 bg-primary/4 p-4 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/12 shrink-0">
          <CheckCircle2 className="w-4.5 h-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate text-foreground">{file.name}</div>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {file.size > 1024 * 1024
              ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
              : `${(file.size / 1024).toFixed(1)} KB`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
          onClick={(e) => { e.stopPropagation(); onFileSelect(null); }}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-all",
        isDragActive
          ? "border-primary/50 bg-primary/5 shadow-[0_0_0_4px_oklch(0.60_0.175_68_/_0.08)]"
          : "border-border bg-card hover:border-primary/30 hover:bg-muted/20"
      )}
    >
      <input {...getInputProps()} />
      <div className={cn(
        "flex items-center justify-center w-12 h-12 rounded-2xl transition-colors",
        isDragActive ? "bg-primary/15" : "bg-muted/70"
      )}>
        {isDragActive
          ? <Upload className="w-5 h-5 text-primary" />
          : <Icon className="w-5 h-5 text-muted-foreground/50" />
        }
      </div>
      <div className="text-center space-y-1">
        <div className="text-[13.5px] font-semibold text-foreground/80">{label}</div>
        <div className="text-[11.5px] text-muted-foreground/70">{description}</div>
      </div>
    </div>
  );
}
