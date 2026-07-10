// src/components/chat/services/exportChat.ts
//
// Chat export logic — generates markdown and saves/copies to clipboard.

import type { ChatMessage } from "../../../types";

export async function exportChatToMarkdown(
  messages: ChatMessage[],
  title: string,
): Promise<{ success: boolean; message: string }> {
  if (messages.length === 0) {
    return { success: false, message: "" };
  }

  const date = new Date().toISOString().split("T")[0];

  let markdown = `# ${title}\n\n`;
  markdown += `*Exported from PunamIDE on ${date}*\n\n---\n\n`;

  for (const msg of messages) {
    const role = msg.role === "user" ? "**You**" : "**Punam**";
    const modeTag = msg.mode ? ` _(${msg.mode} mode)_` : "";
    markdown += `### ${role}${modeTag}\n\n`;

    if (msg.parsed?.explanation) {
      markdown += `${msg.parsed.explanation}\n\n`;
      if (msg.parsed.fileChanges.length > 0) {
        markdown += `**Files changed:**\n`;
        for (const fc of msg.parsed.fileChanges) {
          markdown += `- ${fc.isNew ? "Created" : "Modified"}: \`${fc.path}\`\n`;
        }
        markdown += "\n";
      }
    } else {
      markdown += `${msg.content}\n\n`;
    }

    if (msg.attachments && msg.attachments.length > 0) {
      markdown += `*Attachments: ${msg.attachments.map((a) => a.name).join(", ")}*\n\n`;
    }

    markdown += "---\n\n";
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const filePath = await save({
      defaultPath: `${title.replace(/[^a-zA-Z0-9]/g, "_")}_${date}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (filePath) {
      await writeTextFile(filePath, markdown);
      return { success: true, message: `✅ Chat exported to \`${filePath}\`` };
    }
    return { success: false, message: "" };
  } catch {
    try {
      await navigator.clipboard.writeText(markdown);
      return { success: true, message: "✅ Chat copied to clipboard (save dialog unavailable)." };
    } catch {
      return { success: false, message: "⚠️ Could not export chat. Try again." };
    }
  }
}
