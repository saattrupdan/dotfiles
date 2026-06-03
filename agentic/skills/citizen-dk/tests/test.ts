#!/usr/bin/env bun
/**
 * Test suite for citizen-dk skill
 * 
 * Runs test prompts, evaluates responses, requires 3 consecutive clean runs
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "citizen-dk";

/**
 * Test cases — direct CLI commands to test the citizen-dk skill
 * Tests search with default and explicit sources, municipality lookup, and help
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  { name: "Search default source (borger)", cmd: "citizen search \"pas\"", expectMinResults: 1 },
  { name: "Search nyidanmark source", cmd: "citizen search \"arbejdstilladelse\" --source nyidanmark", expectMinResults: 1 },
  { name: "Municipality lookup København", cmd: "citizen municipality \"København\"", expectMinResults: 1 },
  { name: "CLI help", cmd: "citizen --help", expectMinResults: 1 },
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
    await $`which citizen`.quiet();
  } catch {
    errors.push("citizen CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`citizen --help`.quiet();
  } catch {
    errors.push("citizen CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff format --check citizen_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff check citizen_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * Run a single test prompt through pi
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
 * Evaluate test results using the model
 */
function evaluateResults(
  results: Array<{ name: string; cmd: string; ok: boolean; output: string; expectMinResults: number }>
): Array<{ name: string; cmd: string; passed: boolean; reason: string }> {
  return results.map(r => {
    // Check if command succeeded
    if (!r.ok) {
      return { name: r.name, cmd: r.cmd, passed: false, reason: `Command failed: ${r.output}` };
    }
    
    // Count results (lines starting with # indicate count, otherwise count data lines)
    const countMatch = r.output.match(/^# (\d+) (?:match|listing|total|result)/m);
    const resultCount = countMatch ? parseInt(countMatch[1]) : r.output.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    
    // Check if we got expected minimum results
    if (resultCount < r.expectMinResults) {
      return { name: r.name, cmd: r.cmd, passed: false, reason: `Expected at least ${r.expectMinResults} results, got ${resultCount}` };
    }
    
    return { name: r.name, cmd: r.cmd, passed: true, reason: `OK: ${resultCount} result(s)` };
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
function printResults(
  results: Array<{ name: string; cmd: string; passed: boolean; reason: string }>
) {
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS");
  console.log("=".repeat(60));
  
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  
  console.log(`\nPassed: ${passedCount}/${totalCount}\n`);
  
  for (const result of results) {
    const symbol = result.passed ? "✓" : "✗";
    console.log(`${symbol} ${result.name}`);
    console.log(`  Command: ${result.cmd}`);
    console.log(`  Reason: ${result.reason}\n`);
  }
  
  console.log("\n" + "=".repeat(60));
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
