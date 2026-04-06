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
      <div className="relative flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3.5">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/15 shrink-0">
          <CheckCircle2 className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate text-foreground">{file.name}</div>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
            {file.size > 1024 * 1024
              ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
              : `${(file.size / 1024).toFixed(1)} KB`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onFileSelect(null);
          }}
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
        "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-all bg-card",
        isDragActive
          ? "border-primary/60 bg-primary/8"
          : "border-border hover:border-primary/40 hover:bg-muted/20"
      )}
    >
      <input {...getInputProps()} />
      <div className={cn(
        "flex items-center justify-center w-10 h-10 rounded-lg transition-colors",
        isDragActive ? "bg-primary/15" : "bg-muted"
      )}>
        {isDragActive
          ? <Upload className="w-4 h-4 text-primary" />
          : <Icon className="w-4 h-4 text-muted-foreground/60" />
        }
      </div>
      <div className="text-center">
        <div className="text-[13px] font-medium text-foreground/80">{label}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
      </div>
    </div>
  );
}
