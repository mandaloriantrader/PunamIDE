/**
 * ResponseBlock — final markdown response with syntax-highlighted code blocks.
 *
 * During streaming: shows typing cursor.
 */
import { MarkdownMessage } from "./ChatComponents";

interface Props {
  content: string;
  isStreaming?: boolean;
}

export default function ResponseBlock({ content, isStreaming = false }: Props) {
  return (
    <div className={`cl-response ${isStreaming ? "streaming" : "complete"}`}>
      <MarkdownMessage text={content} />
      {isStreaming && <span className="cl-cursor">▍</span>}
    </div>
  );
}