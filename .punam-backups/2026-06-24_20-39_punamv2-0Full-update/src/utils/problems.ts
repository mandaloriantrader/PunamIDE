export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  id: string;
  path: string;
  line: number;
  column?: number;
  message: string;
  severity: ProblemSeverity;
  source: string;
}

const FILE_EXT_PATTERN = /\.(tsx?|jsx?|css|scss|html|json|rs|py|go|java|kt|cs|cpp|c|h|hpp|rb|php|swift|dart|md|toml|yaml|yml)\b/i;

function normalizeProblemPath(path: string, projectRoot = "") {
  const normalizedRoot = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath;
}

function severityFromText(text: string): ProblemSeverity {
  if (/\bwarning\b/i.test(text)) return "warning";
  if (/\binfo\b|\bnote\b/i.test(text)) return "info";
  return "error";
}

function pushProblem(
  problems: Problem[],
  seen: Set<string>,
  path: string,
  line: string | number,
  column: string | number | undefined,
  message: string,
  source: string,
  projectRoot: string
) {
  const normalizedPath = normalizeProblemPath(path, projectRoot);
  if (!normalizedPath || !FILE_EXT_PATTERN.test(normalizedPath)) return;

  const parsedLine = Number(line);
  if (!Number.isFinite(parsedLine) || parsedLine < 1) return;

  const parsedColumn = column === undefined ? undefined : Number(column);
  const cleanMessage = message.trim() || "Problem detected";
  const key = `${normalizedPath}:${parsedLine}:${parsedColumn || 0}:${cleanMessage}`;
  if (seen.has(key)) return;
  seen.add(key);

  problems.push({
    id: key,
    path: normalizedPath,
    line: parsedLine,
    column: Number.isFinite(parsedColumn) && parsedColumn! > 0 ? parsedColumn : undefined,
    message: cleanMessage,
    severity: severityFromText(cleanMessage),
    source,
  });
}

export function parseProblemsFromOutput(output: string, source = "Run", projectRoot = ""): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(.+)$/);
    if (tsMatch) {
      pushProblem(problems, seen, tsMatch[1], tsMatch[2], tsMatch[3], tsMatch[4], source, projectRoot);
      continue;
    }

    const colonMatch = line.match(/^(.+):(\d+):(?:(\d+):)?\s*(.+)$/);
    if (colonMatch) {
      pushProblem(problems, seen, colonMatch[1], colonMatch[2], colonMatch[3], colonMatch[4], source, projectRoot);
      continue;
    }

    const pythonMatch = line.match(/^\s*File "(.+?)", line (\d+)(?:, in .*)?$/);
    if (pythonMatch) {
      const nextMessage = lines.slice(i + 1, i + 5).find((item) => item.trim() && !item.trim().startsWith("^")) || "Python error";
      pushProblem(problems, seen, pythonMatch[1], pythonMatch[2], undefined, nextMessage.trim(), source, projectRoot);
    }
  }

  return problems;
}
