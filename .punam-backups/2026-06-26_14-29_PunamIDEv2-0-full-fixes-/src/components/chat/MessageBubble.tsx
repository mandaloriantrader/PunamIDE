/**
 * MessageBubble — container for a single AI turn, arranging structured blocks
 * (thinking → tool_call → tool_result → … → response) in order.
 */

import type { StreamBlock, ThinkingBlock as TThinkingBlock, ToolCallBlock as TToolCallBlock, ToolResultBlock as TToolResultBlock, ResponseBlock as TResponseBlock } from "../../utils/protocol";
import ThinkingBlock from "./ThinkingBlock";
import ToolCallCard from "./ToolCallCard";
import ToolResultCard from "./ToolResultCard";
import ResponseBlock from "./ResponseBlock";

interface Props {
  blocks: StreamBlock[];
  /** True while the overall AI response is still being generated. */
  isStreaming?: boolean;
}

export default function MessageBubble({ blocks, isStreaming = false }: Props) {
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
}