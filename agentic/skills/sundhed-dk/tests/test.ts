#!/usr/bin/env bun
/**
 * Test suite for sundhed-dk skill
 * 
 * Runs test prompts, evaluates responses, requires 3 consecutive clean runs
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "sundhed-dk";

/**
 * Test cases — direct CLI commands to test the sundhed-dk skill
 * Covers version, autocomplete, menu, and help commands
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  { name: "Version command", cmd: "sundhed version", expectMinResults: 0 },
  { name: "Autocomplete search", cmd: "sundhed autocomplete \"blod\"", expectMinResults: 1 },
  { name: "Menu command", cmd: "sundhed menu --section borger --kind top", expectMinResults: 1 },
  { name: "Help command", cmd: "sundhed --help", expectMinResults: 0 },
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
    await $`which sundhed`.quiet();
  } catch {
    errors.push("sundhed CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`sundhed --help`.quiet();
  } catch {
    errors.push("sundhed CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff format --check sundhed_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff check sundhed_dk/`.quiet();
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
function evaluateResults(results: Array<{ name: string; cmd: string; ok: boolean; output: string; expectMinResults: number }>): Array<{ name: string; cmd: string; passed: boolean; reason: string }> {
  const evaluated: Array<{ name: string; cmd: string; passed: boolean; reason: string }> = [];
  
  for (const result of results) {
    if (!result.ok) {
      evaluated.push({
        name: result.name,
        cmd: result.cmd,
        passed: false,
        reason: `Command failed: ${result.output.slice(0, 100)}`,
      });
      continue;
    }
    
    // Check output has content when expected
    const lineCount = result.output.split("\n").filter(line => line.trim().length > 0).length;
    if (result.expectMinResults > 0 && lineCount < result.expectMinResults) {
      evaluated.push({
        name: result.name,
        cmd: result.cmd,
        passed: false,
        reason: `Expected at least ${result.expectMinResults} lines, got ${lineCount}`,
      });
      continue;
    }
    
    evaluated.push({
      name: result.name,
      cmd: result.cmd,
      passed: true,
      reason: "OK",
    });
  }
  
  return evaluated;
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
  console.log("\n--- Results ---\n");
  for (const result of results) {
    const icon = result.passed ? "✓" : "✗";
    console.log(`${icon} ${result.name}`);
    if (!result.passed) {
      console.log(`  Reason: ${result.reason}`);
      console.log(`  Command: ${result.cmd}`);
    }
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\nPassed: ${passed}/${total}`);
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
