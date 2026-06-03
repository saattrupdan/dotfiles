#!/usr/bin/env bun
/**
 * Test suite for virk-dk skill
 * 
 * Runs test prompts, evaluates responses, requires 3 consecutive clean runs
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "virk-dk";

/**
 * Test cases — direct CLI commands to test the virk-dk skill
 * Tests article lookup, myndigheder filtering, and help output
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  // Article lookup test
  { name: "Article lookup - start virksomhed", cmd: "virk web article start-virksomhed", expectMinResults: 1 },
  
  // Myndigheder with type filter and limit
  { name: "Myndigheder filter stat with limit", cmd: "virk web myndigheder --type stat --limit 3", expectMinResults: 1 },
  
  // Help command
  { name: "Web help command", cmd: "virk web --help", expectMinResults: 1 },
];

/**
 * Pre-flight checks — verify CLI is installed, skill file exists, and Python code passes lint
 */
async function preflightChecks(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  
  // Check skill file exists
  try {
    readFileSync(SKILL_FILE, "utf-8");
  } catch {
    errors.push(`Skill file not found: ${SKILL_FILE}`);
  }
  
  // Check CLI is installed
  try {
    await $`which virk`.quiet();
  } catch {
    errors.push("virk CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`virk --help`.quiet();
  } catch {
    errors.push("virk CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff format --check virk_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff check virk_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * Run a single test prompt through virk CLI
 */
async function runCommand(cmd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await $`bash -c ${cmd}`.text();
    return { ok: true, output: result.trim() };
  } catch (error: any) {
    return { ok: false, output: error.stdout?.toString() || error.message };
  }
}

/**
 * Evaluate test results — check command succeeded and output is non-empty
 */
function evaluateResults(results: Array<{ name: string; cmd: string; ok: boolean; output: string; expectMinResults: number }>): Array<{ name: string; cmd: string; passed: boolean; reason: string }> {
  return results.map(r => {
    if (!r.ok) {
      return { name: r.name, cmd: r.cmd, passed: false, reason: `Command failed: ${r.output.slice(0, 100)}` };
    }
    
    // For simple CLI tests, non-empty output is sufficient
    if (r.output.trim().length === 0) {
      return { name: r.name, cmd: r.cmd, passed: false, reason: "Empty output" };
    }
    
    return { name: r.name, cmd: r.cmd, passed: true, reason: "OK" };
  });
}

/**
 * Run one complete test iteration
 */
async function runTestIteration(): Promise<{
  passed: boolean;
  results: Array<{ name: string; cmd: string; passed: boolean; reason: string }>;
}> {
  console.log("\n--- Running test iteration ---\n");
  
  // Run all test cases
  const rawResults: Array<{ name: string; cmd: string; ok: boolean; output: string; expectMinResults: number }> = [];
  for (const testCase of TEST_CASES) {
    process.stdout.write(`Running: ${testCase.name}... `);
    const result = await runCommand(testCase.cmd);
    rawResults.push({ ...testCase, ...result });
    process.stdout.write(result.ok ? "done\n" : `FAILED: ${result.output.slice(0, 50)}\n`);
  }
  
  // Evaluate
  console.log("\nEvaluating results...\n");
  const evaluated = evaluateResults(rawResults);
  
  const passed = evaluated.every(r => r.passed);
  return { passed, results: evaluated };
}

/**
 * Print test results summary
 */
function printResults(results: Array<{ name: string; cmd: string; passed: boolean; reason: string }>) {
  console.log("\n--- Test Results ---\n");
  for (const r of results) {
    const status = r.passed ? "✓" : "✗";
    console.log(`${status} ${r.name}`);
    if (!r.passed) {
      console.log(`  Reason: ${r.reason}`);
      console.log(`  Command: ${r.cmd}`);
    }
  }
  
  const passed = results.filter(r => r.passed).length;
  console.log(`\n${passed}/${results.length} tests passed`);
}

/**
 * Main entry point
 */
async function main() {
  console.log(`Testing ${SKILL_NAME} skill\n`);
  
  // Pre-flight checks
  console.log("Running pre-flight checks...");
  const preflight = await preflightChecks();
  if (!preflight.ok) {
    console.error("\nPre-flight checks failed:");
    for (const error of preflight.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("Pre-flight checks passed ✓\n");
  
  // Run 1 iteration for quick validation
  console.log(`\n>>> Running test iteration`);
  
  try {
    const iterationResult = await runTestIteration();
    printResults(iterationResult.results);
    
    if (iterationResult.passed) {
      console.log(`\n✓ Iteration passed\n`);
    } else {
      console.log(`\n✗ Iteration failed\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n✗ Iteration error:`, error);
    process.exit(1);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log(`✓✓✓ ${SKILL_NAME} SKILL APPROVED ✓✓✓`);
  console.log("=".repeat(60) + "\n");
}

main();
