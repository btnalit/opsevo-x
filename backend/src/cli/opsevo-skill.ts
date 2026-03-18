#!/usr/bin/env node
/**
 * opsevo-skill CLI — Skill Capsule 骨架生成器
 *
 * Usage:
 *   npx opsevo-skill init --name <skill-name> [--runtime node|python|bash]
 *
 * Requirements: E5.16
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InitOptions {
  name: string;
  runtime: 'node' | 'python' | 'bash';
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generateConfigJson(opts: InitOptions): string {
  const config = {
    id: uuidv4(),
    name: opts.name,
    version: '0.1.0',
    description: `${opts.name} skill capsule — TODO: add description`,
    capabilities: ['TODO'],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Input query' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Execution result' },
      },
      required: ['result'],
    },
    runtime: opts.runtime,
    entrypoint: opts.runtime === 'python' ? 'main.py' : 'index.ts',
    dependencies: [] as unknown[],
    healthCheck: {
      endpoint: '/health',
      intervalMs: 60000,
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function generateSkillMd(opts: InitOptions): string {
  return `---
name: ${opts.name}
description: TODO — describe what this skill does
version: 0.1.0
author: TODO
tags:
  - TODO
triggers:
  - TODO
---

# ${opts.name}

TODO: Describe the skill's purpose and behaviour.

## Usage

Explain when and how this skill is invoked.

## Tools

List the tools this skill may use.

## Output

Describe the expected output format.
`;
}

function generateIndexTs(opts: InitOptions): string {
  return `/**
 * ${opts.name} — Skill Capsule entry point
 *
 * This file is the main entry point referenced by capsule.json "entrypoint".
 */

export interface SkillInput {
  query: string;
}

export interface SkillOutput {
  result: string;
}

export async function execute(input: SkillInput): Promise<SkillOutput> {
  // TODO: implement skill logic
  return { result: \`Executed ${opts.name} with query: \${input.query}\` };
}
`;
}

function generateMainPy(opts: InitOptions): string {
  return `"""
${opts.name} — Skill Capsule entry point (Python)

This file is the main entry point referenced by capsule.json "entrypoint".
"""

import json
import sys


def execute(input_data: dict) -> dict:
    """TODO: implement skill logic."""
    query = input_data.get("query", "")
    return {"result": f"Executed ${opts.name} with query: {query}"}


if __name__ == "__main__":
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    output = execute(data)
    print(json.dumps(output))
`;
}

function generateTestFile(opts: InitOptions): string {
  if (opts.runtime === 'python') {
    return `"""Basic tests for ${opts.name} skill capsule."""

import json
import pathlib


def test_config_valid():
    config_path = pathlib.Path(__file__).resolve().parent.parent / "capsule.json"
    config = json.loads(config_path.read_text())
    assert config["name"] == "${opts.name}"
    assert config["runtime"] == "python"
    assert "capabilities" in config
`;
  }

  return `import * as fs from 'fs';
import * as path from 'path';

describe('${opts.name} skill capsule', () => {
  const configPath = path.resolve(__dirname, '..', 'capsule.json');

  it('should have a valid capsule.json', () => {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    expect(config.name).toBe('${opts.name}');
    expect(config.runtime).toBe('${opts.runtime}');
    expect(config.version).toMatch(/^\\d+\\.\\d+\\.\\d+$/);
    expect(Array.isArray(config.capabilities)).toBe(true);
    expect(config.inputSchema).toBeDefined();
    expect(config.outputSchema).toBeDefined();
    expect(config.entrypoint).toBeDefined();
  });
});
`;
}

// ---------------------------------------------------------------------------
// CLI logic
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command?: string; name?: string; runtime?: string } {
  const result: { command?: string; name?: string; runtime?: string } = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !result.command) {
      result.command = arg;
    } else if (arg === '--name' && i + 1 < argv.length) {
      result.name = argv[++i];
    } else if (arg === '--runtime' && i + 1 < argv.length) {
      result.runtime = argv[++i];
    }
    i++;
  }
  return result;
}

async function promptForName(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Skill name: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function validateName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

function printUsage(): void {
  console.log(`
Usage: opsevo-skill init --name <skill-name> [--runtime node|python|bash]

Commands:
  init    Generate a new Skill Capsule skeleton

Options:
  --name      Skill name (lowercase, hyphens allowed)
  --runtime   Runtime type: node (default), python, bash
`);
}

async function runInit(args: { name?: string; runtime?: string }): Promise<void> {
  let name = args.name;
  if (!name) {
    name = await promptForName();
  }
  if (!name || !validateName(name)) {
    console.error(`Error: Invalid skill name "${name ?? ''}". Use lowercase letters, digits, and hyphens (must start with a letter).`);
    process.exit(1);
  }

  const runtime = (args.runtime ?? 'node') as InitOptions['runtime'];
  if (!['node', 'python', 'bash'].includes(runtime)) {
    console.error(`Error: Invalid runtime "${runtime}". Must be one of: node, python, bash`);
    process.exit(1);
  }

  const opts: InitOptions = { name, runtime };
  const targetDir = path.resolve(process.cwd(), name);

  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory "${name}" already exists.`);
    process.exit(1);
  }

  // Create directory structure
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(targetDir, '__tests__'), { recursive: true });

  // Write files
  fs.writeFileSync(path.join(targetDir, 'capsule.json'), generateConfigJson(opts));
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), generateSkillMd(opts));

  if (runtime === 'python') {
    fs.writeFileSync(path.join(targetDir, 'main.py'), generateMainPy(opts));
    fs.writeFileSync(path.join(targetDir, '__tests__', `test_${name.replace(/-/g, '_')}.py`), generateTestFile(opts));
  } else {
    fs.writeFileSync(path.join(targetDir, 'index.ts'), generateIndexTs(opts));
    fs.writeFileSync(path.join(targetDir, '__tests__', `${name}.test.ts`), generateTestFile(opts));
  }

  console.log(`\n✅ Skill Capsule "${name}" created at ./${name}/`);
  console.log(`\n   ${name}/`);
  console.log(`   ├── capsule.json`);
  console.log(`   ├── SKILL.md`);
  if (runtime === 'python') {
    console.log(`   ├── main.py`);
    console.log(`   └── __tests__/test_${name.replace(/-/g, '_')}.py`);
  } else {
    console.log(`   ├── index.ts`);
    console.log(`   └── __tests__/${name}.test.ts`);
  }
  console.log(`\nNext steps:`);
  console.log(`  1. Edit capsule.json — fill in description, capabilities, schemas`);
  console.log(`  2. Edit SKILL.md — document the skill behaviour`);
  console.log(`  3. Implement the skill logic in ${runtime === 'python' ? 'main.py' : 'index.ts'}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    printUsage();
    process.exit(0);
  }

  if (args.command === 'init') {
    await runInit(args);
  } else {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
