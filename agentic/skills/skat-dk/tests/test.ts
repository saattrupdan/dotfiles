#!/usr/bin/env bun
/**
 * Test suite for skat-dk skill
 * 
 * Runs test prompts, evaluates responses, requires 3 consecutive clean runs
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "skat-dk";

/**
 * Test cases — direct CLI commands to test the skat-dk skill
 * Tests settings, search with size, sitemap with limit, and help
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  { name: "settings", cmd: "skat settings 13369", expectMinResults: 1 },
  { name: "search forskudtopgørelse with size", cmd: "skat search \"forskudtopgørelse\" --size 3", expectMinResults: 1 },
  { name: "sitemap with limit", cmd: "skat sitemap --limit 2", expectMinResults: 1 },
  { name: "help", cmd: "skat --help", expectMinResults: 1 },
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
    await $`which skat`.quiet();
  } catch {
    errors.push("skat CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`skat --help`.quiet();
  } catch {
    errors.push("skat CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff format --check skat_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff check skat_dk/`.quiet();
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
function printResults(results: Array<{ name: string; cmd: string; passed: boolean; reason: string }>) {
  console.log("\n=== Test Results ===\n");
  
  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`${icon} ${r.name}`);
    console.log(`   ${r.reason}`);
    if (!r.passed) {
      console.log(`   Command: ${r.cmd}`);
    }
    console.log();
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`Passed: ${passed}/${total}`);
}

/**
 * Main entry point
 */
async function main() {
  console.log(`\n=== ${SKILL_NAME} Test Suite ===`);
  
  // Pre-flight checks
  console.log("\nRunning pre-flight checks...\n");
  const preflight = await preflightChecks();
  
  if (!preflight.ok) {
    console.error("\n❌ Pre-flight checks failed:");
    for (const error of preflight.errors) {
      console.error(`  - ${error}`);
    }
    console.error("\nFix these issues before running tests.");
    process.exit(1);
  }
  
  console.log("✅ Pre-flight checks passed\n");
  
  // Run 3 consecutive successful iterations
  let consecutivePasses = 0;
  const requiredPasses = 3;
  
  while (consecutivePasses < requiredPasses) {
    const { passed, results } = await runTestIteration();
    printResults(results);
    
    if (passed) {
      consecutivePasses++;
      console.log(`\nConsecutive passes: ${consecutivePasses}/${requiredPasses}\n`);
    } else {
      consecutivePasses = 0;
      console.log("\n❌ Test iteration failed. Resetting consecutive pass count.\n");
      process.exit(1);
    }
  }
  
  console.log(`\n🎉 All ${requiredPasses} consecutive test iterations passed!\n`);
}

main();
