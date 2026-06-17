/**
 * DiffViewer — Side-by-side diff display with line-by-line coloring.
 * Shows added/removed/context lines with gutter numbers.
 * Ported from Zenith IDE, adapted for Punam IDE.
 */

interface Props {
  oldContent: string;
  newContent: string;
  fileName: string;
}

/**
 * Simple unified diff generator.
 * Produces lines prefixed with +, -, or space.
 */
function generateSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: string[] = [];

  // Simple LCS-based diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi >= oldLines.length) {
      // Remaining new lines are additions
      result.push(`+ ${newLines[ni]}`);
      ni++;
    } else if (ni >= newLines.length) {
      // Remaining old lines are deletions
      result.push(`- ${oldLines[oi]}`);
      oi++;
    } else if (oldLines[oi] === newLines[ni]) {
      // Context line
      result.push(`  ${oldLines[oi]}`);
      oi++;
      ni++;
    } else {
      // Look ahead to find if old line appears later in new
      let foundInNew = -1;
      let foundInOld = -1;
      const lookAhead = Math.min(5, maxLen);

      for (let k = 1; k <= lookAhead; k++) {
        if (ni + k < newLines.length && oldLines[oi] === newLines[ni + k]) {
          foundInNew = ni + k;
          break;
        }
        if (oi + k < oldLines.length && oldLines[oi + k] === newLines[ni]) {
          foundInOld = oi + k;
          break;
        }
      }

      if (foundInNew > -1) {
        // Lines were added before current old line
        while (ni < foundInNew) {
          result.push(`+ ${newLines[ni]}`);
          ni++;
        }
      } else if (foundInOld > -1) {
        // Lines were removed before current new line
        while (oi < foundInOld) {
          result.push(`- ${oldLines[oi]}`);
          oi++;
        }
      } else {
        // Replace: old line removed, new line added
        result.push(`- ${oldLines[oi]}`);
        result.push(`+ ${newLines[ni]}`);
        oi++;
        ni++;
      }
    }
  }

  return result.join("\n");
}

export default function DiffViewer({ oldContent, newContent, fileName }: Props) {
  const diff = generateSimpleDiff(oldContent, newContent);
  const lines = diff.split("\n");

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <span className="diff-filename">{fileName}</span>
        <span className="diff-stats">
          <span className="diff-added">
            +{lines.filter((l) => l.startsWith("+")).length}
          </span>
          <span className="diff-removed">
            -{lines.filter((l) => l.startsWith("-")).length}
          </span>
        </span>
      </div>
      <div className="diff-content">
        {lines.map((line, i) => {
          let cls = "diff-line context";
          if (line.startsWith("+")) cls = "diff-line added";
          else if (line.startsWith("-")) cls = "diff-line removed";

          return (
            <div key={i} className={cls}>
              <span className="diff-gutter">{i + 1}</span>
              <span className="diff-indicator">
                {line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " "}
              </span>
              <pre className="diff-text">{line.slice(2)}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
