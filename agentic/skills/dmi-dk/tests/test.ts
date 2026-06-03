#!/usr/bin/env bun
/**
 * Test suite for dmi-dk skill
 * 
 * Runs test prompts through the dmi CLI, validates responses
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "dmi-dk";

/**
 * Test cases — direct CLI commands to test the dmi-dk skill
 * Covers core commands: --help, city-search, forecast-city
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  // CLI help (no network required)
  { name: "CLI help", cmd: "dmi --help", expectMinResults: 1 },
  
  // City search with --id-only (minimal, reliable output)
  { name: "City search Aarhus", cmd: "dmi city-search århus --id-only", expectMinResults: 1 },
  { name: "City search København", cmd: "dmi city-search københavn --id-only", expectMinResults: 1 },
  
  // Weather forecast cities
  { name: "Forecast city København", cmd: "dmi forecast-city københavn", expectMinResults: 1 },
  { name: "Forecast city Odense", cmd: "dmi forecast-city odense", expectMinResults: 1 },
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
    await $`which dmi`.quiet();
  } catch {
    errors.push("dmi CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`dmi --help`.quiet();
  } catch {
    errors.push("dmi CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`uv run ruff format --check ${SKILL_DIR}/dmi_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`uv run ruff check ${SKILL_DIR}/dmi_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * Run a single test command with retry for network flakiness
 */
async function runCommand(cmd: string, retries = 3): Promise<{ ok: boolean; output: string }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await $`bash -c ${cmd}`.text();
      return { ok: true, output: result.trim() };
    } catch (error: any) {
      const output = error.stdout?.toString() || error.message;
      if (attempt === retries) {
        return { ok: false, output };
      }
      // Exponential backoff: 500ms, 1s, 2s
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, output: "unexpected failure" };
}

/**
 * Evaluate test results
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
    const countMatch = r.output.match(/^# (\d+) (?:match|listing|total)/m);
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
