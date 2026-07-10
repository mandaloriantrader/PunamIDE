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
 *
 * Refactored to factory pattern: createBlockParser() returns independent
 * instances with isolated state. Legacy module-level exports are preserved
 * for backward compatibility.
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

// ── Parser State Interface ────────────────────────────────────────────────

export interface ParserState {
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

// ── BlockParser Interface ─────────────────────────────────────────────────

export interface BlockParser {
  /** Append new streaming text and return parse result. */
  appendStreamText: (text: string) => BlockParseResult;
  /** Get a readonly snapshot of the current parser state. */
  getState: () => Readonly<ParserState>;
  /** Reset the parser to initial state. */
  reset: () => void;
  /** Parse complete text at once (used for finalization). */
  parseStreamBlocks: (rawText: string) => BlockParseResult;
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

// ── Factory Function ──────────────────────────────────────────────────────

/**
 * Create a new independent BlockParser instance.
 * Each instance maintains its own closure-captured ParserState,
 * preventing cross-stream corruption.
 */
export function createBlockParser(): BlockParser {
  let state = createState();

  function appendStreamTextImpl(newText: string): BlockParseResult {
    // Append new text to the buffer
    state.buffer += newText;

    const completed: StreamBlock[] = [];

    // Keep scanning from the last cursor position until we exhaust new content
    while (state.cursor < state.buffer.length) {
      // ── No open block — look for an opening tag ─────────────────────────
      if (state.openBlock === null) {
        const openTag = findFirstTag(
          state.buffer,
          state.cursor,
          ALL_OPEN_TAGS
        );
        if (openTag === null) {
          // No more tags — anything remaining is unstructured text before the
          // first block, or trailing text after all blocks have closed.
          state.preamble = state.buffer.slice(state.cursor).trim();
          state.cursor = state.buffer.length;
          break;
        }

        // ── Preamble text before the first opening tag ────────────────────
        if (state.cursor < openTag.index) {
          state.preamble = state.buffer.slice(state.cursor, openTag.index).trim();
        }

        // Skip past the opening tag
        state.cursor = openTag.index + openTag.tag.length;
        state.openBlock = openTag.kind;
        state.contentStart = state.cursor;

        // Reset tool-specific state
        state.toolName = "";
        state.toolParams = "";
        state.inToolParams = false;
        continue;
      }

      // ── Open block — look for either a close tag or a nested open tag ───
      if (state.openBlock === "tool_call" && !state.inToolParams) {
        const paramsIdx = state.buffer.indexOf(
          OPEN_TAGS.tool_params,
          state.cursor
        );
        const closeIdx = state.buffer.indexOf(
          CLOSE_TAGS.tool_call,
          state.cursor
        );

        if (
          paramsIdx !== -1 &&
          (closeIdx === -1 || paramsIdx < closeIdx)
        ) {
          // Found <tool_params> — capture tool name from content so far
          const content = state.buffer.slice(
            state.contentStart!,
            paramsIdx
          ).trim();
          state.toolName = content.split("\n")[0].trim();

          state.cursor = paramsIdx + OPEN_TAGS.tool_params.length;
          state.inToolParams = true;
          state.contentStart = state.cursor;
          continue;
        }
      }

      // Look for closing tag of the current open block
      const closeTag = CLOSE_TAGS[state.openBlock];
      const closeIdx = state.buffer.indexOf(closeTag, state.cursor);

      if (closeIdx !== -1) {
        // ── Block is complete ─────────────────────────────────────────────
        const content = state.buffer.slice(state.contentStart!, closeIdx).trim();

        // If inside tool_params, capture that content first
        if (state.inToolParams) {
          state.toolParams = content;
          state.inToolParams = false;
        }

        switch (state.openBlock) {
          case "thinking":
            completed.push(makeThinkingBlock(content));
            break;
          case "tool_call":
            completed.push(
              makeToolCallBlock(state.toolName, state.toolParams, true)
            );
            break;
          case "tool_result":
            completed.push(makeToolResultBlock(content));
            break;
          case "response":
            completed.push(makeResponseBlock(content, false));
            break;
        }

        state.cursor = closeIdx + closeTag.length;
        state.openBlock = null;
        state.contentStart = null;
        continue;
      }

      // ── No close tag found — block is still streaming ──────────────────
      break;
    }

    // ── Build in-progress block (if any) ──────────────────────────────────
    let inProgress: StreamBlock | null = null;
    if (
      state.openBlock !== null &&
      state.contentStart !== null &&
      state.cursor < state.buffer.length
    ) {
      const content = state.buffer.slice(state.contentStart).trim();

      switch (state.openBlock) {
        case "thinking":
          inProgress = makeThinkingBlock(content);
          break;
        case "tool_call": {
          if (state.inToolParams) {
            state.toolParams = content;
          } else {
            state.toolName = content.split("\n")[0].trim();
          }
          inProgress = makeToolCallBlock(
            state.toolName,
            state.toolParams,
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

    // ── If we have preamble text and no blocks have been opened yet, ──────
    // emit it as a thinking block so the user sees something happening.
    if (completed.length === 0 && inProgress === null && state.preamble && state.openBlock === null) {
      inProgress = makeThinkingBlock(state.preamble);
    }

    return { completed, inProgress };
  }

  function parseStreamBlocksImpl(rawText: string): BlockParseResult {
    // Replace the buffer with the full raw text
    state.buffer = rawText;
    state.cursor = 0;
    state.preamble = "";

    const completed: StreamBlock[] = [];

    // Keep scanning until we exhaust the buffer
    while (state.cursor < state.buffer.length) {
      if (state.openBlock === null) {
        const openTag = findFirstTag(
          state.buffer,
          state.cursor,
          ALL_OPEN_TAGS
        );
        if (openTag === null) {
          state.preamble = state.buffer.slice(state.cursor).trim();
          state.cursor = state.buffer.length;
          break;
        }

        if (state.cursor < openTag.index) {
          state.preamble = state.buffer.slice(state.cursor, openTag.index).trim();
          if (state.preamble) {
            completed.push(makeThinkingBlock(state.preamble));
            state.preamble = "";
          }
        }

        state.cursor = openTag.index + openTag.tag.length;
        state.openBlock = openTag.kind;
        state.contentStart = state.cursor;

        state.toolName = "";
        state.toolParams = "";
        state.inToolParams = false;
        continue;
      }

      if (state.openBlock === "tool_call" && !state.inToolParams) {
        const paramsIdx = state.buffer.indexOf(
          OPEN_TAGS.tool_params,
          state.cursor
        );
        const closeIdx = state.buffer.indexOf(
          CLOSE_TAGS.tool_call,
          state.cursor
        );

        if (
          paramsIdx !== -1 &&
          (closeIdx === -1 || paramsIdx < closeIdx)
        ) {
          const content = state.buffer.slice(
            state.contentStart!,
            paramsIdx
          ).trim();
          state.toolName = content.split("\n")[0].trim();

          state.cursor = paramsIdx + OPEN_TAGS.tool_params.length;
          state.inToolParams = true;
          state.contentStart = state.cursor;
          continue;
        }
      }

      const closeTag = CLOSE_TAGS[state.openBlock];
      const closeIdx = state.buffer.indexOf(closeTag, state.cursor);

      if (closeIdx !== -1) {
        const content = state.buffer.slice(state.contentStart!, closeIdx).trim();

        if (state.inToolParams) {
          state.toolParams = content;
          state.inToolParams = false;
        }

        switch (state.openBlock) {
          case "thinking":
            completed.push(makeThinkingBlock(content));
            break;
          case "tool_call":
            completed.push(
              makeToolCallBlock(state.toolName, state.toolParams, true)
            );
            break;
          case "tool_result":
            completed.push(makeToolResultBlock(content));
            break;
          case "response":
            completed.push(makeResponseBlock(content, false));
            break;
        }

        state.cursor = closeIdx + closeTag.length;
        state.openBlock = null;
        state.contentStart = null;
        continue;
      }

      // No close tag found — malformed, skip to end
      state.cursor = state.buffer.length;
      break;
    }

    // Handle preamble with no blocks at all
    if (completed.length === 0 && state.preamble) {
      completed.push(makeThinkingBlock(state.preamble));
    }

    // Build in-progress block (if close tag was never found)
    let inProgress: StreamBlock | null = null;
    if (
      state.openBlock !== null &&
      state.contentStart !== null &&
      state.cursor < state.buffer.length
    ) {
      const content = state.buffer.slice(state.contentStart).trim();
      switch (state.openBlock) {
        case "thinking":
          inProgress = makeThinkingBlock(content);
          break;
        case "tool_call": {
          if (state.inToolParams) {
            state.toolParams = content;
          } else {
            state.toolName = content.split("\n")[0].trim();
          }
          inProgress = makeToolCallBlock(state.toolName, state.toolParams, false);
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

  return {
    appendStreamText: appendStreamTextImpl,
    getState: () => state as Readonly<ParserState>,
    reset: () => { state = createState(); },
    parseStreamBlocks: parseStreamBlocksImpl,
  };
}

// ── Module-Level Instance (Legacy Compatibility) ──────────────────────────

/**
 * Module-level BlockParser instance used by legacy exports.
 * resetParseState() replaces this with a fresh instance.
 */
let _moduleInstance = createBlockParser();

/**
 * Reset the parser for a new streaming message.
 * Replaces the module-level instance with a fresh one from the factory.
 */
export function resetParseState(): void {
  _moduleInstance = createBlockParser();
}

/**
 * Append new streaming text to the module-level parser instance.
 * Legacy export for backward compatibility.
 */
export function appendStreamText(newText: string): BlockParseResult {
  return _moduleInstance.appendStreamText(newText);
}

/**
 * Parse the FULL raw text at once (used for finalizing after streaming completes).
 * Legacy export for backward compatibility — delegates to the module-level instance.
 */
export function parseStreamBlocks(rawText: string): BlockParseResult {
  return _moduleInstance.parseStreamBlocks(rawText);
}
