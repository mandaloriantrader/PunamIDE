/**
 * Streaming block parser.
 *
 * Splits raw streaming text into structured blocks (thinking, tool_call,
 * tool_result, response) as tokens arrive.  Handles edge cases where XML
 * tags are split across token boundaries.
 *
 * Now truly incremental — appendStreamText() only scans new text,
 * and preamble text before the first XML tag is preserved as a thinking block
 * instead of being silently discarded.
 */

import type {
  StreamBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
  ResponseBlock,
  BlockParseResult,
} from "./protocol";

// ── Tag Patterns ──────────────────────────────────────────────────────────

const OPEN_TAGS: Record<string, string> = {
  thinking: "<thinking>",
  tool_call: "<tool_call>",
  tool_params: "<tool_params>",
  tool_result: "<tool_result>",
  response: "<response>",
};

const CLOSE_TAGS: Record<string, string> = {
  thinking: "</thinking>",
  tool_call: "</tool_call>",
  tool_params: "</tool_params>",
  tool_result: "</tool_result>",
  response: "</response>",
};

// Ordered list for scanning priority (longest first to avoid partial matches)
const ALL_OPEN_TAGS = Object.entries(OPEN_TAGS).sort(
  (a, b) => b[1].length - a[1].length
);

// ── Internal State ────────────────────────────────────────────────────────

interface ParserState {
  /** Raw text accumulated so far (appended incrementally). */
  buffer: string;
  /** Index in buffer of the last fully-processed character. */
  cursor: number;
  /** Currently open block kind, if any. */
  openBlock: string | null;
  /** Start index (absolute) of the open block's content in the buffer. */
  contentStart: number | null;
  /** For tool_call: the accumulated tool name. */
  toolName: string;
  /** For tool_call: the raw params text (between <tool_params> and </tool_params> or </tool_call>). */
  toolParams: string;
  /** Whether we're inside a <tool_params> sub-block. */
  inToolParams: boolean;
  /** Text before the first XML block was encountered (preamble). */
  preamble: string;
}

function createState(): ParserState {
  return {
    buffer: "",
    cursor: 0,
    openBlock: null,
    contentStart: null,
    toolName: "",
    toolParams: "",
    inToolParams: false,
    preamble: "",
  };
}

// Singleton: one parser per chat message (caller resets via resetParseState)
let _state = createState();

/** Reset the parser for a new streaming message. */
export function resetParseState(): void {
  _state = createState();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function findFirstTag(
  text: string,
  start: number,
  tags: Array<[string, string]>
): { kind: string; tag: string; index: number } | null {
  let best: { kind: string; tag: string; index: number } | null = null;
  for (const [kind, tag] of tags) {
    const idx = text.indexOf(tag, start);
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { kind, tag, index: idx };
    }
  }
  return best;
}

function makeThinkingBlock(content: string): ThinkingBlock {
  return { kind: "thinking", content };
}

function makeToolCallBlock(
  name: string,
  params: string,
  isComplete: boolean
): ToolCallBlock {
  return { kind: "tool_call", name, params, isComplete };
}

function makeToolResultBlock(content: string): ToolResultBlock {
  return { kind: "tool_result", content };
}

function makeResponseBlock(
  content: string,
  isStreaming: boolean
): ResponseBlock {
  return { kind: "response", content, isStreaming };
}

// ── Incremental Append (P4) ────────────────────────────────────────────────

/**
 * Append new streaming text to the parser and continue scanning from the
 * last cursor position.  This avoids re-scanning the entire buffer every
 * frame — only the new text + any previously-unfinished scan is processed.
 *
 * Returns a list of newly completed blocks and (optionally) one in-progress block.
 */
export function appendStreamText(newText: string): BlockParseResult {
  // Append new text to the buffer
  _state.buffer += newText;

  const completed: StreamBlock[] = [];

  // Keep scanning from the last cursor position until we exhaust new content
  while (_state.cursor < _state.buffer.length) {
    // ── No open block — look for an opening tag ───────────────────────────
    if (_state.openBlock === null) {
      const openTag = findFirstTag(
        _state.buffer,
        _state.cursor,
        ALL_OPEN_TAGS
      );
      if (openTag === null) {
        // No more tags — anything remaining is unstructured text before the
        // first block, or trailing text after all blocks have closed.
        // Save it as preamble so it can be surfaced (P5 fix).
        _state.preamble = _state.buffer.slice(_state.cursor).trim();
        _state.cursor = _state.buffer.length;
        break;
      }

      // ── P5: Preamble text before the first opening tag ──────────────────
      if (_state.cursor < openTag.index) {
        _state.preamble = _state.buffer.slice(_state.cursor, openTag.index).trim();
      }

      // Skip past the opening tag
      _state.cursor = openTag.index + openTag.tag.length;
      _state.openBlock = openTag.kind;
      _state.contentStart = _state.cursor;

      // Reset tool-specific state
      _state.toolName = "";
      _state.toolParams = "";
      _state.inToolParams = false;
      continue;
    }

    // ── Open block — look for either a close tag or a nested open tag ───
    // If we are inside a `tool_call` block, we also look for `<tool_params>`
    if (_state.openBlock === "tool_call" && !_state.inToolParams) {
      // Check for <tool_params> first
      const paramsIdx = _state.buffer.indexOf(
        OPEN_TAGS.tool_params,
        _state.cursor
      );
      const closeIdx = _state.buffer.indexOf(
        CLOSE_TAGS.tool_call,
        _state.cursor
      );

      if (
        paramsIdx !== -1 &&
        (closeIdx === -1 || paramsIdx < closeIdx)
      ) {
        // Found <tool_params> — capture tool name from content so far
        const content = _state.buffer.slice(
          _state.contentStart!,
          paramsIdx
        ).trim();
        _state.toolName = content.split("\n")[0].trim(); // first line is tool name

        _state.cursor = paramsIdx + OPEN_TAGS.tool_params.length;
        _state.inToolParams = true;
        _state.contentStart = _state.cursor;
        continue;
      }
    }

    // Look for closing tag of the current open block
    const closeTag = CLOSE_TAGS[_state.openBlock];
    const closeIdx = _state.buffer.indexOf(closeTag, _state.cursor);

    if (closeIdx !== -1) {
      // ── Block is complete ───────────────────────────────────────────────
      const content = _state.buffer.slice(_state.contentStart!, closeIdx).trim();

      // If inside tool_params, capture that content first
      if (_state.inToolParams) {
        _state.toolParams = content;
        _state.inToolParams = false;
      }

      switch (_state.openBlock) {
        case "thinking":
          completed.push(makeThinkingBlock(content));
          break;
        case "tool_call":
          completed.push(
            makeToolCallBlock(_state.toolName, _state.toolParams, true)
          );
          break;
        case "tool_result":
          completed.push(makeToolResultBlock(content));
          break;
        case "response":
          completed.push(makeResponseBlock(content, false));
          break;
      }

      _state.cursor = closeIdx + closeTag.length;
      _state.openBlock = null;
      _state.contentStart = null;
      continue;
    }

    // ── No close tag found — block is still streaming ────────────────────
    // Exit the scan loop; the in-progress block will be built below.
    break;
  }

  // ── Build in-progress block (if any) ────────────────────────────────────
  let inProgress: StreamBlock | null = null;
  if (
    _state.openBlock !== null &&
    _state.contentStart !== null &&
    _state.cursor < _state.buffer.length
  ) {
    const content = _state.buffer.slice(_state.contentStart).trim();

    switch (_state.openBlock) {
      case "thinking":
        inProgress = makeThinkingBlock(content);
        break;
      case "tool_call": {
        if (_state.inToolParams) {
          _state.toolParams = content;
        } else {
          _state.toolName = content.split("\n")[0].trim();
        }
        inProgress = makeToolCallBlock(
          _state.toolName,
          _state.toolParams,
          false
        );
        break;
      }
      case "tool_result":
        inProgress = makeToolResultBlock(content);
        break;
      case "response":
        inProgress = makeResponseBlock(content, true);
        break;
    }
  }

  // ── P5: If we have preamble text and no blocks have been opened yet, ────
  // emit it as a thinking block so the user sees something happening.
  // This is emitted only on the first flush where preamble is found.
  if (completed.length === 0 && inProgress === null && _state.preamble && _state.openBlock === null) {
    inProgress = makeThinkingBlock(_state.preamble);
  }

  return { completed, inProgress };
}

// ── Legacy Full-Replace Parser (kept for full-response finalization) ──────

/**
 * Parse the FULL raw text at once (used for finalizing after streaming completes).
 * This resets the internal state and returns all completed blocks.
 */
export function parseStreamBlocks(rawText: string): BlockParseResult {
  // Replace the buffer with the full raw text
  _state.buffer = rawText;
  _state.cursor = 0;
  _state.preamble = "";

  const completed: StreamBlock[] = [];

  // Keep scanning until we exhaust the buffer
  while (_state.cursor < _state.buffer.length) {
    // ── No open block — look for an opening tag ───────────────────────────
    if (_state.openBlock === null) {
      const openTag = findFirstTag(
        _state.buffer,
        _state.cursor,
        ALL_OPEN_TAGS
      );
      if (openTag === null) {
        // No more tags — capture remaining text as preamble
        _state.preamble = _state.buffer.slice(_state.cursor).trim();
        _state.cursor = _state.buffer.length;
        break;
      }

      // P5: Capture preamble before the first tag
      if (_state.cursor < openTag.index) {
        _state.preamble = _state.buffer.slice(_state.cursor, openTag.index).trim();
        if (_state.preamble) {
          completed.push(makeThinkingBlock(_state.preamble));
          _state.preamble = "";
        }
      }

      // Skip past the opening tag
      _state.cursor = openTag.index + openTag.tag.length;
      _state.openBlock = openTag.kind;
      _state.contentStart = _state.cursor;

      // Reset tool-specific state
      _state.toolName = "";
      _state.toolParams = "";
      _state.inToolParams = false;
      continue;
    }

    // ── Open block — look for either a close tag or a nested open tag ───
    if (_state.openBlock === "tool_call" && !_state.inToolParams) {
      const paramsIdx = _state.buffer.indexOf(
        OPEN_TAGS.tool_params,
        _state.cursor
      );
      const closeIdx = _state.buffer.indexOf(
        CLOSE_TAGS.tool_call,
        _state.cursor
      );

      if (
        paramsIdx !== -1 &&
        (closeIdx === -1 || paramsIdx < closeIdx)
      ) {
        const content = _state.buffer.slice(
          _state.contentStart!,
          paramsIdx
        ).trim();
        _state.toolName = content.split("\n")[0].trim();

        _state.cursor = paramsIdx + OPEN_TAGS.tool_params.length;
        _state.inToolParams = true;
        _state.contentStart = _state.cursor;
        continue;
      }
    }

    // Look for closing tag of the current open block
    const closeTag = CLOSE_TAGS[_state.openBlock];
    const closeIdx = _state.buffer.indexOf(closeTag, _state.cursor);

    if (closeIdx !== -1) {
      const content = _state.buffer.slice(_state.contentStart!, closeIdx).trim();

      if (_state.inToolParams) {
        _state.toolParams = content;
        _state.inToolParams = false;
      }

      switch (_state.openBlock) {
        case "thinking":
          completed.push(makeThinkingBlock(content));
          break;
        case "tool_call":
          completed.push(
            makeToolCallBlock(_state.toolName, _state.toolParams, true)
          );
          break;
        case "tool_result":
          completed.push(makeToolResultBlock(content));
          break;
        case "response":
          completed.push(makeResponseBlock(content, false));
          break;
      }

      _state.cursor = closeIdx + closeTag.length;
      _state.openBlock = null;
      _state.contentStart = null;
      continue;
    }

    // No close tag found — malformed, skip to end
    _state.cursor = _state.buffer.length;
    break;
  }

  // ── Handle preamble with no blocks at all ──────────────────────────────
  if (completed.length === 0 && _state.preamble) {
    completed.push(makeThinkingBlock(_state.preamble));
  }

  // Build in-progress block (if close tag was never found)
  let inProgress: StreamBlock | null = null;
  if (
    _state.openBlock !== null &&
    _state.contentStart !== null &&
    _state.cursor < _state.buffer.length
  ) {
    const content = _state.buffer.slice(_state.contentStart).trim();
    switch (_state.openBlock) {
      case "thinking":
        inProgress = makeThinkingBlock(content);
        break;
      case "tool_call": {
        if (_state.inToolParams) {
          _state.toolParams = content;
        } else {
          _state.toolName = content.split("\n")[0].trim();
        }
        inProgress = makeToolCallBlock(_state.toolName, _state.toolParams, false);
        break;
      }
      case "tool_result":
        inProgress = makeToolResultBlock(content);
        break;
      case "response":
        inProgress = makeResponseBlock(content, true);
        break;
    }
  }

  return { completed, inProgress };
}