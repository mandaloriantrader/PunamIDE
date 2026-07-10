/**
 * ContextWindowBar — Token usage progress bar.
 *
 * Shows: used tokens / model max context with a visual progress bar.
 * Colors: green (<60%), yellow (60-85%), red (>85%).
 * Renders below the input box, full width, one thin line.
 */

import { getContextWindowSize, formatTokens } from '../../utils/contextWindowSize'

interface Props {
  /** Total tokens consumed in this conversation (input + output). */
  tokensUsed: number
  /** Active model ID (used to resolve context window size). */
  modelId: string
  /** Optional override for context window size (from ModelConfig.contextWindow or provider API). */
  contextWindowOverride?: number | null
}

export function ContextWindowBar({ tokensUsed, modelId, contextWindowOverride }: Props) {
  const maxTokens = contextWindowOverride ?? getContextWindowSize(modelId)

  // If we don't know the model's context size, show minimal info
  if (!maxTokens) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 12px 5px', fontSize: '10px', fontFamily: 'inherit', color: 'var(--text-muted, #6c7086)' }}>
        <span style={{ color: 'var(--text-secondary, #a6adc8)', fontWeight: 500 }}>
          {formatTokens(tokensUsed)} tokens used
        </span>
      </div>
    )
  }

  const pct = Math.min((tokensUsed / maxTokens) * 100, 100)
  const color =
    pct >= 75 ? 'var(--red, #f38ba8)' :
    pct >= 50 ? 'var(--yellow, #f9e2af)' :
    'var(--green, #a6e3a1)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 12px 5px', fontSize: '10px', fontFamily: 'inherit', color: 'var(--text-muted, #6c7086)' }}>
      <span style={{ minWidth: '32px', textAlign: 'right', fontWeight: 500, color: 'var(--text-secondary, #a6adc8)' }}>
        {formatTokens(tokensUsed)}
      </span>
      <div style={{ flex: 1, height: '3px', background: 'var(--bg-tertiary, #1e1e2e)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '2px', transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ minWidth: '32px', fontWeight: 500, color: 'var(--accent, #89b4fa)' }}>
        {formatTokens(maxTokens)}
      </span>
    </div>
  )
}
