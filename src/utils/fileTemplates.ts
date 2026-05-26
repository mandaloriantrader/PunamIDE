/**
 * File Templates — pre-built code snippets for new file creation.
 * Used by the FileTemplatePicker component.
 */

export interface FileTemplate {
  id: string;
  name: string;
  description: string;
  category: "react" | "node" | "python" | "rust" | "general" | "test";
  filename: string;
  language: string;
  icon: string; // emoji
  content: (name: string) => string;
}

/** Derive a PascalCase component name from a filename */
function toPascal(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Derive a camelCase name */
function toCamel(filename: string): string {
  const pascal = toPascal(filename);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export const FILE_TEMPLATES: FileTemplate[] = [
  // ── React ──────────────────────────────────────────────────────────────────
  {
    id: "react-fc",
    name: "React Component",
    description: "Functional component with TypeScript props",
    category: "react",
    filename: "MyComponent.tsx",
    language: "typescriptreact",
    icon: "⚛️",
    content: (name) => {
      const comp = toPascal(name);
      return `import { useState } from "react";

interface ${comp}Props {
  // Define your props here
}

export default function ${comp}({ }: ${comp}Props) {
  return (
    <div className="${toCamel(name)}">
      <h2>${comp}</h2>
    </div>
  );
}
`;
    },
  },
  {
    id: "react-context",
    name: "React Context",
    description: "Context + Provider + hook pattern",
    category: "react",
    filename: "MyContext.tsx",
    language: "typescriptreact",
    icon: "🔗",
    content: (name) => {
      const base = toPascal(name).replace(/Context$/i, "");
      return `import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

interface ${base}ContextValue {
  // Add your context values here
}

const ${base}Context = createContext<${base}ContextValue | null>(null);

export function ${base}Provider({ children }: { children: ReactNode }) {
  // Add your state here

  return (
    <${base}Context.Provider value={{}}>
      {children}
    </${base}Context.Provider>
  );
}

export function use${base}() {
  const ctx = useContext(${base}Context);
  if (!ctx) throw new Error("use${base} must be used within ${base}Provider");
  return ctx;
}
`;
    },
  },
  {
    id: "react-hook",
    name: "Custom Hook",
    description: "Reusable React hook with TypeScript",
    category: "react",
    filename: "useMyHook.ts",
    language: "typescript",
    icon: "🪝",
    content: (name) => {
      const hookName = name.startsWith("use") ? toCamel(name) : `use${toPascal(name)}`;
      return `import { useState, useEffect } from "react";

interface ${toPascal(hookName)}Options {
  // Options
}

interface ${toPascal(hookName)}Result {
  // Return type
}

export function ${hookName}(options?: ${toPascal(hookName)}Options): ${toPascal(hookName)}Result {
  const [value, setValue] = useState(null);

  useEffect(() => {
    // Effect logic
  }, []);

  return { value };
}
`;
    },
  },
  {
    id: "react-page",
    name: "React Page",
    description: "Full page component with loading & error states",
    category: "react",
    filename: "MyPage.tsx",
    language: "typescriptreact",
    icon: "📄",
    content: (name) => {
      const comp = toPascal(name).replace(/Page$/i, "") + "Page";
      return `import { useState, useEffect } from "react";

export default function ${comp}() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        // Fetch data here
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <main className="${toCamel(comp)}">
      <h1>${comp.replace(/Page$/, "")}</h1>
    </main>
  );
}
`;
    },
  },
  // ── Node / Express ─────────────────────────────────────────────────────────
  {
    id: "express-route",
    name: "Express Route",
    description: "Express router with GET/POST handlers",
    category: "node",
    filename: "myRoute.ts",
    language: "typescript",
    icon: "🚀",
    content: (name) => {
      const base = toCamel(name).replace(/Route$/i, "");
      return `import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

// GET /${base}
router.get("/", async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /${base}
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body;
    res.status(201).json({ success: true, data: body });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
`;
    },
  },
  {
    id: "ts-util",
    name: "TypeScript Utility",
    description: "Utility functions module with types",
    category: "general",
    filename: "utils.ts",
    language: "typescript",
    icon: "🔧",
    content: (name) => {
      const mod = toPascal(name).replace(/Utils?$/i, "");
      return `/**
 * ${mod} utility functions
 */

export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const group = String(item[key]);
    acc[group] = acc[group] ?? [];
    acc[group].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}
`;
    },
  },
  // ── Python ──────────────────────────────────────────────────────────────────
  {
    id: "python-class",
    name: "Python Class",
    description: "Python class with __init__, __repr__, properties",
    category: "python",
    filename: "my_class.py",
    language: "python",
    icon: "🐍",
    content: (name) => {
      const cls = toPascal(name.replace(/_/g, "-"));
      return `from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ${cls}:
    """${cls} description."""

    name: str
    value: Optional[int] = None
    tags: list[str] = field(default_factory=list)

    def __repr__(self) -> str:
        return f"${cls}(name={self.name!r}, value={self.value})"

    def process(self) -> dict:
        """Process and return result."""
        return {"name": self.name, "value": self.value, "tags": self.tags}
`;
    },
  },
  {
    id: "fastapi-route",
    name: "FastAPI Router",
    description: "FastAPI router with Pydantic models",
    category: "python",
    filename: "router.py",
    language: "python",
    icon: "⚡",
    content: (name) => {
      const tag = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      return `from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

router = APIRouter(prefix="/${name.replace(/[-_]/g, "-")}", tags=["${tag}"])


class ItemBase(BaseModel):
    name: str
    description: Optional[str] = None


class ItemCreate(ItemBase):
    pass


class Item(ItemBase):
    id: int

    class Config:
        from_attributes = True


@router.get("/", response_model=List[Item])
async def list_items():
    return []


@router.get("/{item_id}", response_model=Item)
async def get_item(item_id: int):
    raise HTTPException(status_code=404, detail="Item not found")


@router.post("/", response_model=Item, status_code=201)
async def create_item(item: ItemCreate):
    return {"id": 1, **item.dict()}
`;
    },
  },
  // ── Rust ───────────────────────────────────────────────────────────────────
  {
    id: "rust-struct",
    name: "Rust Struct",
    description: "Rust struct with impl block and derive macros",
    category: "rust",
    filename: "my_struct.rs",
    language: "rust",
    icon: "🦀",
    content: (name) => {
      const struct_name = toPascal(name.replace(/_/g, "-"));
      return `use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct ${struct_name} {
    pub name: String,
    pub value: i64,
}

impl ${struct_name} {
    pub fn new(name: impl Into<String>, value: i64) -> Self {
        Self {
            name: name.into(),
            value,
        }
    }

    pub fn process(&self) -> Result<String, Box<dyn std::error::Error>> {
        Ok(format!("{}: {}", self.name, self.value))
    }
}

impl fmt::Display for ${struct_name} {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${struct_name}({})", self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new() {
        let item = ${struct_name}::new("test", 42);
        assert_eq!(item.name, "test");
        assert_eq!(item.value, 42);
    }
}
`;
    },
  },
  // ── Test ───────────────────────────────────────────────────────────────────
  {
    id: "vitest-suite",
    name: "Vitest Test Suite",
    description: "Vitest test file with describe/it/expect",
    category: "test",
    filename: "myModule.test.ts",
    language: "typescript",
    icon: "🧪",
    content: (name) => {
      const mod = toPascal(name).replace(/\.test$/, "");
      return `import { describe, it, expect, beforeEach, vi } from "vitest";
// import { ${toCamel(mod)} } from "./${name.replace(/\.test\.ts$/, "")}";

describe("${mod}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic functionality", () => {
    it("should work correctly", () => {
      expect(true).toBe(true);
    });

    it("should handle edge cases", () => {
      expect(null).toBeNull();
    });
  });

  describe("error handling", () => {
    it("should throw on invalid input", () => {
      expect(() => {
        throw new Error("Invalid");
      }).toThrow("Invalid");
    });
  });
});
`;
    },
  },
  {
    id: "pytest-suite",
    name: "Pytest Test Suite",
    description: "Python pytest file with fixtures",
    category: "test",
    filename: "test_module.py",
    language: "python",
    icon: "🧪",
    content: (name) => {
      const mod = name.replace(/^test_/, "").replace(/_/g, " ");
      return `import pytest
# from ${name.replace(/^test_/, "")} import ...


@pytest.fixture
def sample_data():
    """Provide sample test data."""
    return {"key": "value", "number": 42}


class Test${toPascal(name.replace(/^test_/, ""))}:
    """Test suite for ${mod}."""

    def test_basic_functionality(self, sample_data):
        assert sample_data["key"] == "value"

    def test_edge_case(self):
        with pytest.raises(ValueError):
            raise ValueError("Expected error")

    @pytest.mark.parametrize("input,expected", [
        (1, 2),
        (2, 4),
        (3, 6),
    ])
    def test_parametrized(self, input, expected):
        assert input * 2 == expected
`;
    },
  },
  // ── General ────────────────────────────────────────────────────────────────
  {
    id: "markdown-doc",
    name: "Markdown Doc",
    description: "Documentation markdown with standard sections",
    category: "general",
    filename: "README.md",
    language: "markdown",
    icon: "📝",
    content: (name) => {
      const title = toPascal(name.replace(/\.md$/i, "").replace(/[-_]/g, " "));
      return `# ${title}

> Brief description of what this is.

## Features

- Feature one
- Feature two
- Feature three

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

\`\`\`typescript
// Example usage
\`\`\`

## API

### \`functionName(param)\`

Description of the function.

**Parameters:**
- \`param\` — description

**Returns:** description

## License

MIT
`;
    },
  },
  {
    id: "json-config",
    name: "JSON Config",
    description: "Configuration file with common fields",
    category: "general",
    filename: "config.json",
    language: "json",
    icon: "⚙️",
    content: (name) => {
      const key = name.replace(/\.json$/i, "");
      return `{
  "$schema": "",
  "name": "${key}",
  "version": "1.0.0",
  "description": "",
  "settings": {
    "enabled": true,
    "debug": false
  }
}
`;
    },
  },
];

export const TEMPLATE_CATEGORIES = [
  { id: "all",     label: "All" },
  { id: "react",   label: "React" },
  { id: "node",    label: "Node / Express" },
  { id: "python",  label: "Python" },
  { id: "rust",    label: "Rust" },
  { id: "test",    label: "Tests" },
  { id: "general", label: "General" },
] as const;
