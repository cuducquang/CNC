"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText, Box } from "lucide-react";

interface FileUploadProps {
  label: string;
  accept: Record<string, string[]>;
  file: File | null;
  onFileSelect: (file: File | null) => void;
  icon: "3d" | "2d";
}

export default function FileUpload({
  label,
  accept,
  file,
  onFileSelect,
  icon,
}: FileUploadProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFileSelect(acceptedFiles[0]);
      }
    },
    [onFileSelect]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxFiles: 1,
  });

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
        isDragActive
          ? "border-blue-400 bg-blue-50"
          : file
          ? "border-green-300 bg-green-50"
          : "border-gray-300 hover:border-blue-300 hover:bg-blue-50/50"
      }`}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-3">
        {file ? (
          <>
            {icon === "3d" ? (
              <Box className="w-10 h-10 text-green-500" />
            ) : (
              <FileText className="w-10 h-10 text-green-500" />
            )}
            <div>
              <p className="text-sm font-medium text-green-700">{file.name}</p>
              <p className="text-xs text-green-600 mt-1">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFileSelect(null);
              }}
              className="text-xs text-red-500 hover:text-red-700 underline"
            >
              Remove
            </button>
          </>
        ) : (
          <>
            {icon === "3d" ? (
              <Box className="w-10 h-10 text-gray-400" />
            ) : (
              <Upload className="w-10 h-10 text-gray-400" />
            )}
            <div>
              <p className="text-sm font-medium text-gray-700">{label}</p>
              <p className="text-xs text-gray-500 mt-1">
                {isDragActive
                  ? "Drop the file here"
                  : "Drag & drop or click to browse"}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
