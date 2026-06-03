#!/usr/bin/env bun
/**
 * Test suite for linkedin skill
 * 
 * Tests CLI structure and help commands since actual posting requires auth
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "linkedin";

/**
 * Test cases — help commands to verify CLI structure
 * Since posting/fetching requires auth, we test the CLI interface
 */
const TEST_CASES: Array<{ name: string; cmd: string; expectMinResults: number }> = [
  { name: "Main help", cmd: "linkedin --help", expectMinResults: 0 },
  { name: "Posts help", cmd: "linkedin posts --help", expectMinResults: 0 },
  { name: "Post help", cmd: "linkedin post --help", expectMinResults: 0 },
  { name: "Draft help", cmd: "linkedin draft --help", expectMinResults: 0 },
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
    await $`which linkedin`.quiet();
  } catch {
    errors.push("linkedin CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`linkedin --help`.quiet();
  } catch {
    errors.push("linkedin CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff format --check linkedin_skill/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`cd ${SKILL_DIR} && uv run ruff check linkedin_skill/`.quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * Run a single test command
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
        reason: `Command failed: ${result.output.slice(0, 200)}`,
      });
    } else {
      // Check output has expected content (help text should be non-empty)
      const output = result.output.trim();
      if (output.length < 50) {
        evaluated.push({
          name: result.name,
          cmd: result.cmd,
          passed: false,
          reason: `Output too short (${output.length} chars), expected help text`,
        });
      } else if (output.toLowerCase().includes("usage") || output.toLowerCase().includes("commands") || output.toLowerCase().includes("options")) {
        evaluated.push({
          name: result.name,
          cmd: result.cmd,
          passed: true,
          reason: "Help text contains expected keywords",
        });
      } else {
        evaluated.push({
          name: result.name,
          cmd: result.cmd,
          passed: true,
          reason: "Command succeeded with output",
        });
      }
    }
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
  console.log("\n" + "=".repeat(60));
  console.log("Test Results:");
  console.log("=".repeat(60));
  
  for (const result of results) {
    const icon = result.passed ? "✓" : "✗";
    console.log(`${icon} ${result.name}`);
    console.log(`  Command: ${result.cmd}`);
    console.log(`  ${result.reason}`);
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
