/**
 * ClarificationDialog — Inline panel for pre-flight ambiguity clarification.
 *
 * Positioned above the chat input (no modal backdrop). Shows the detected
 * ambiguity question, option buttons (A/B/C), a free-text alternative,
 * and a "Skip, just go" dismiss button.
 *
 * Auto-dismisses after 5 minutes of inactivity via onSkip().
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { HelpCircle, SkipForward, Send } from "lucide-react";
import type { AmbiguityReport } from "../services/agent/AmbiguityDetector";

interface Props {
  report: AmbiguityReport;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
}

const TIMEOUT_MS = 300_000; // 5 minutes

export default function ClarificationDialog({ report, onAnswer, onSkip }: Props) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");
  const firstBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on first interactive element when dialog appears
  useEffect(() => {
    if (report.suggestedOptions.length > 0) {
      firstBtnRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [report.suggestedOptions.length]);

  // 5-minute timeout — auto-skip if user doesn't respond
  useEffect(() => {
    const timer = setTimeout(() => {
      onSkip();
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [onSkip]);

  const handleSelectOption = useCallback((option: string) => {
    setSelectedOption(option);
    setCustomAnswer(""); // deselect custom text when option is picked
  }, []);

  const handleCustomChange = useCallback((value: string) => {
    setCustomAnswer(value);
    setSelectedOption(null); // deselect option when typing custom text
  }, []);

  const handleSubmit = useCallback(() => {
    const answer = selectedOption || customAnswer.trim();
    if (answer) {
      onAnswer(answer);
    }
  }, [selectedOption, customAnswer, onAnswer]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const question = report.suggestedQuestion || report.primaryAmbiguity?.description || "";
  const options = report.suggestedOptions;

  return (
    <div className="clarification-panel" role="dialog" aria-label="Clarification needed">
      <div className="clarification-header">
        <HelpCircle size={14} className="clarification-icon" />
        <span className="clarification-label">Quick clarification</span>
      </div>

      <p className="clarification-question">{question}</p>

      {options.length > 0 && (
        <div className="clarification-options">
          {options.map((option, index) => (
            <button
              key={index}
              ref={index === 0 ? firstBtnRef : undefined}
              className={`clarification-option-btn${selectedOption === option ? " selected" : ""}`}
              onClick={() => handleSelectOption(option)}
              type="button"
            >
              <span className="clarification-option-key">
                {String.fromCharCode(65 + index)}
              </span>
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="clarification-custom">
        <input
          ref={inputRef}
          type="text"
          className="clarification-input"
          placeholder="Or type your own answer..."
          value={customAnswer}
          onChange={(e) => handleCustomChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="clarification-submit-btn"
          onClick={handleSubmit}
          disabled={!selectedOption && !customAnswer.trim()}
          title="Submit answer"
          type="button"
        >
          <Send size={13} />
        </button>
      </div>

      <div className="clarification-footer">
        <button className="clarification-skip-btn" onClick={onSkip} type="button">
          <SkipForward size={12} />
          Skip, just go
        </button>
      </div>
    </div>
  );
}
