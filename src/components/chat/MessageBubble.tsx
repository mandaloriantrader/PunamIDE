/**
 * MessageBubble — container for a single AI turn, arranging structured blocks
 * (thinking → tool_call → tool_result → … → response) in order.
 *
 * Wrapped in React.memo with a custom arePropsEqual to minimize re-renders:
 * - Completed messages only re-render if message.id or message.content change
 * - Streaming messages only re-render if isStreaming changes or streamingBlocks reference changes
 */

import React from "react";
import type { StreamBlock, BlockParseResult, ThinkingBlock as TThinkingBlock, ToolCallBlock as TToolCallBlock, ToolResultBlock as TToolResultBlock, ResponseBlock as TResponseBlock } from "../../utils/protocol";
import type { ChatMessage } from "../../types";
import ThinkingBlock from "./ThinkingBlock";
import ToolCallCard from "./ToolCallCard";
import ToolResultCard from "./ToolResultCard";
import ResponseBlock from "./ResponseBlock";

export interface MessageBubbleProps {
  /** The chat message object — used for stable identity comparison on completed messages. */
  message: ChatMessage;
  /** True while this message is actively streaming. */
  isStreaming: boolean;
  /** RAF-flushed streaming blocks for the actively streaming message. */
  streamingBlocks?: BlockParseResult;
}

/**
 * Custom comparison function for React.memo.
 *
 * - When both prev/next have isStreaming=false (completed messages):
 *   skip re-render if message.id and message.content are unchanged.
 * - When either has isStreaming=true (active streaming):
 *   skip re-render if isStreaming values match AND streamingBlocks reference is identical.
 * - Otherwise: allow re-render.
 */
export function areMessageBubblePropsEqual(
  prev: MessageBubbleProps,
  next: MessageBubbleProps
): boolean {
  // Streaming case: either prev or next is streaming
  if (prev.isStreaming || next.isStreaming) {
    return prev.isStreaming === next.isStreaming &&
           prev.streamingBlocks === next.streamingBlocks;
  }
  // Completed case: both have isStreaming=false
  // Compare by id (if available) and content for stable identity
  const idMatch = prev.message.id !== undefined && next.message.id !== undefined
    ? prev.message.id === next.message.id
    : prev.message === next.message; // fallback to reference equality if no id
  return idMatch && prev.message.content === next.message.content;
}

const MessageBubble = React.memo<MessageBubbleProps>(
  function MessageBubble({ message, isStreaming, streamingBlocks }) {
    // Determine which blocks to render:
    // - During streaming: use streamingBlocks (completed + inProgress)
    // - After completion: use message.blocks
    let blocks: StreamBlock[];
    if (isStreaming && streamingBlocks) {
      blocks = [
        ...streamingBlocks.completed,
        ...(streamingBlocks.inProgress ? [streamingBlocks.inProgress] : []),
      ];
    } else {
      blocks = message.blocks || [];
    }

    if (blocks.length === 0) {
      return (
        <div className="cl-message-bubble empty">
          <p className="cl-message-pending">Generating response…</p>
        </div>
      );
    }

    return (
      <div className="cl-message-bubble">
        <div className="cl-message-stack">
          {blocks.map((block, i) => {
            switch (block.kind) {
              case "thinking":
                return (
                  <ThinkingBlock
                    key={`think-${i}`}
                    content={(block as TThinkingBlock).content}
                    isStreaming={isStreaming}
                  />
                );
              case "tool_call":
                return (
                  <ToolCallCard
                    key={`tc-${i}`}
                    name={(block as TToolCallBlock).name}
                    params={(block as TToolCallBlock).params}
                    isComplete={(block as TToolCallBlock).isComplete}
                    isError={false}
                  />
                );
              case "tool_result":
                return (
                  <ToolResultCard
                    key={`tr-${i}`}
                    content={(block as TToolResultBlock).content}
                  />
                );
              case "response":
                return (
                  <ResponseBlock
                    key={`resp-${i}`}
                    content={(block as TResponseBlock).content}
                    isStreaming={(block as TResponseBlock).isStreaming}
                  />
                );
              default:
                return null;
            }
          })}
        </div>
      </div>
    );
  },
  areMessageBubblePropsEqual
);

export default MessageBubble;
