"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { Upload, FileBox, FileImage, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface FileDropzoneProps {
  label: string;
  description: string;
  accept: Record<string, string[]>;
  file: File | null;
  onFileSelect: (file: File | null) => void;
  icon: "3d" | "2d";
  required?: boolean;
}

export function FileDropzone({ label, description, accept, file, onFileSelect, icon, required }: FileDropzoneProps) {
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
      <div className="relative flex items-center gap-3 rounded-xl border-2 border-primary/20 bg-primary/5 p-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{file.name}</div>
          <div className="text-xs text-muted-foreground">
            {(file.size / 1024).toFixed(1)} KB
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
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
        "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-all",
        isDragActive
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/20 hover:border-primary/40 hover:bg-muted/50"
      )}
    >
      <input {...getInputProps()} />
      <div className={cn(
        "flex items-center justify-center w-10 h-10 rounded-lg transition-colors",
        isDragActive ? "bg-primary/10" : "bg-muted"
      )}>
        {isDragActive ? (
          <Upload className="w-5 h-5 text-primary" />
        ) : (
          <Icon className="w-5 h-5 text-muted-foreground" />
        )}
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          {required && (
            <Badge variant="destructive" className="text-[9px] px-1 py-0 h-4 leading-none">
              Required
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
    </div>
  );
}
