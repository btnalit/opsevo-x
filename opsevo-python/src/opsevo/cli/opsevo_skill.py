#!/usr/bin/env python3
"""
opsevo-skill CLI — Skill Capsule 骨架生成器

Usage:
    opsevo-skill init --name <skill-name> [--runtime node|python|bash]
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import typer

app = typer.Typer(help="Opsevo Skill Capsule CLI tool")


def _validate_name(name: str) -> bool:
    return bool(re.match(r"^[a-z][a-z0-9-]*$", name))


def _generate_config(name: str, runtime: str) -> str:
    config = {
        "id": str(uuid.uuid4()),
        "name": name,
        "version": "0.1.0",
        "description": f"{name} skill capsule — TODO: add description",
        "capabilities": ["TODO"],
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Input query"}},
            "required": ["query"],
        },
        "outputSchema": {
            "type": "object",
            "properties": {"result": {"type": "string", "description": "Execution result"}},
            "required": ["result"],
        },
        "runtime": runtime,
        "entrypoint": "main.py" if runtime == "python" else "index.ts",
        "dependencies": [],
        "healthCheck": {"endpoint": "/health", "intervalMs": 60000},
    }
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


def _generate_skill_md(name: str) -> str:
    return f"""---
name: {name}
description: TODO — describe what this skill does
version: 0.1.0
author: TODO
tags:
  - TODO
triggers:
  - TODO
---

# {name}

TODO: Describe the skill's purpose and behaviour.

## Usage

Explain when and how this skill is invoked.

## Tools

List the tools this skill may use.

## Output

Describe the expected output format.
"""


def _generate_main_py(name: str) -> str:
    return f'''"""
{name} — Skill Capsule entry point (Python)
"""

import json
import sys


def execute(input_data: dict) -> dict:
    """TODO: implement skill logic."""
    query = input_data.get("query", "")
    return {{"result": f"Executed {name} with query: {{query}}"}}


if __name__ == "__main__":
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {{}}
    output = execute(data)
    print(json.dumps(output))
'''


def _generate_index_ts(name: str) -> str:
    return f"""/**
 * {name} — Skill Capsule entry point
 */

export interface SkillInput {{
  query: string;
}}

export interface SkillOutput {{
  result: string;
}}

export async function execute(input: SkillInput): Promise<SkillOutput> {{
  return {{ result: `Executed {name} with query: ${{input.query}}` }};
}}
"""


def _generate_test(name: str, runtime: str) -> str:
    safe = name.replace("-", "_")
    if runtime == "python":
        return f'''"""Basic tests for {name} skill capsule."""

import json
import pathlib


def test_config_valid():
    config_path = pathlib.Path(__file__).resolve().parent.parent / "capsule.json"
    config = json.loads(config_path.read_text())
    assert config["name"] == "{name}"
    assert config["runtime"] == "python"
    assert "capabilities" in config
'''
    return f"""import * as fs from 'fs';
import * as path from 'path';

describe('{name} skill capsule', () => {{
  const configPath = path.resolve(__dirname, '..', 'capsule.json');

  it('should have a valid capsule.json', () => {{
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    expect(config.name).toBe('{name}');
    expect(config.runtime).toBe('{runtime}');
  }});
}});
"""


@app.command()
def init(
    name: str = typer.Option(..., help="Skill name (lowercase, hyphens allowed)"),
    runtime: str = typer.Option("node", help="Runtime: node, python, bash"),
) -> None:
    """Generate a new Skill Capsule skeleton."""
    if not _validate_name(name):
        typer.echo(
            f'Error: Invalid skill name "{name}". '
            "Use lowercase letters, digits, and hyphens (must start with a letter).",
            err=True,
        )
        raise typer.Exit(1)

    if runtime not in ("node", "python", "bash"):
        typer.echo(f'Error: Invalid runtime "{runtime}". Must be: node, python, bash', err=True)
        raise typer.Exit(1)

    target = Path.cwd() / name
    if target.exists():
        typer.echo(f'Error: Directory "{name}" already exists.', err=True)
        raise typer.Exit(1)

    target.mkdir(parents=True)
    (target / "__tests__").mkdir()

    (target / "capsule.json").write_text(_generate_config(name, runtime), encoding="utf-8")
    (target / "SKILL.md").write_text(_generate_skill_md(name), encoding="utf-8")

    if runtime == "python":
        (target / "main.py").write_text(_generate_main_py(name), encoding="utf-8")
        test_name = f"test_{name.replace('-', '_')}.py"
        (target / "__tests__" / test_name).write_text(
            _generate_test(name, runtime), encoding="utf-8"
        )
    else:
        (target / "index.ts").write_text(_generate_index_ts(name), encoding="utf-8")
        (target / "__tests__" / f"{name}.test.ts").write_text(
            _generate_test(name, runtime), encoding="utf-8"
        )

    typer.echo(f'\n✅ Skill Capsule "{name}" created at ./{name}/')
    typer.echo(f"\n   {name}/")
    typer.echo("   ├── capsule.json")
    typer.echo("   ├── SKILL.md")
    if runtime == "python":
        typer.echo(f"   ├── main.py")
        typer.echo(f"   └── __tests__/test_{name.replace('-', '_')}.py")
    else:
        typer.echo(f"   ├── index.ts")
        typer.echo(f"   └── __tests__/{name}.test.ts")
    typer.echo("\nNext steps:")
    typer.echo("  1. Edit capsule.json — fill in description, capabilities, schemas")
    typer.echo("  2. Edit SKILL.md — document the skill behaviour")
    entry = "main.py" if runtime == "python" else "index.ts"
    typer.echo(f"  3. Implement the skill logic in {entry}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
