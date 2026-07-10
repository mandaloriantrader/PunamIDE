/**
 * Hook for managing file/image attachments in chat.
 * Supports: file picker, drag-and-drop, and clipboard paste (Ctrl+V).
 * Extracted from AiChat.tsx.
 */

import { useState, useRef, useCallback } from "react";
import type { ChatAttachment } from "../utils/tauri";
import type { ChatMessage } from "../types";

interface UseAttachmentsOptions {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];

export function useAttachments({ setMessages }: UseAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileAttach = () => {
    fileInputRef.current?.click();
  };

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ File "${file.name}" is too large (max 10MB).` }]);
        continue;
      }

      const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
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
  }, [setMessages]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  /**
   * Clipboard paste handler — intercepts Ctrl+V / Cmd+V and extracts images.
   * If the clipboard contains image data (e.g. screenshot), it's added as an attachment.
   * Text paste is left untouched (returns false so the textarea handles it normally).
   */
  const handlePaste = useCallback((e: React.ClipboardEvent): boolean => {
    const items = e.clipboardData?.items;
    if (!items) return false;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && ALLOWED_IMAGE_TYPES.includes(item.type)) {
        imageItems.push(item);
      }
    }

    if (imageItems.length === 0) return false;

    // Prevent the paste from inserting weird text into the textarea
    e.preventDefault();

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;

      // Name pasted screenshots with a timestamp
      const name = file.name && file.name !== "image.png"
        ? file.name
        : `pasted-image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${file.type.split("/")[1] || "png"}`;

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const attachment: ChatAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          type: "image",
          mimeType: file.type,
          base64,
          size: file.size,
        };
        setAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    }

    return true; // signals that paste was handled (image captured)
  }, []);

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
    handlePaste,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
  };
}
