/**
 * Hook for managing file/image attachments in chat.
 * Extracted from AiChat.tsx.
 */

import { useState, useRef } from "react";
import type { ChatAttachment } from "../utils/tauri";
import type { ChatMessage } from "../types";

interface UseAttachmentsOptions {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useAttachments({ setMessages }: UseAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileAttach = () => {
    fileInputRef.current?.click();
  };

  const processFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const maxSize = 10 * 1024 * 1024; // 10MB limit
    const allowedImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];

    for (const file of files) {
      if (file.size > maxSize) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ File "${file.name}" is too large (max 10MB).` }]);
        continue;
      }

      const isImage = allowedImageTypes.includes(file.type);
      const reader = new FileReader();

      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const attachment: ChatAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          type: isImage ? "image" : "file",
          mimeType: file.type || "application/octet-stream",
          base64,
          size: file.size,
        };
        setAttachments((prev) => [...prev, attachment]);
      };

      reader.readAsDataURL(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const clearAttachments = () => {
    setAttachments([]);
  };

  return {
    attachments,
    isDragOver,
    fileInputRef,
    handleFileAttach,
    handleFileInputChange,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
  };
}
