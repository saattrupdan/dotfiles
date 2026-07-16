#!/usr/bin/env bun

/**
 * FreshRSS skill test harness
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "freshrss";

//
// Test prompts - natural user questions (not CLI documentation)
//
const TEST_PROMPTS: string[] = [
  "Show me my unread FreshRSS items from the last day",
  "What's new in my feeds? I want to catch up on reading",
  "I'm interested in Python and machine learning - filter my feed digest for those topics",
  "Show me the full content of item abc123",
  "Mark these FreshRSS items as read",
  "Help me set up FreshRSS on my local machine",
  "How do I configure FreshRSS to store my interests?",
  "Check if my FreshRSS connection is working",
];

interface TestResult {
  name: string;
  prompt: string;
  ok: boolean;
  output: string;
  passed: boolean;
  reason: string;
}

//
// Pre-flight checks
//
async function preflightChecks(): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  // Check skill file exists
  try {
    readFileSync(SKILL_FILE, "utf-8");
  } catch {
    errors.push("SKILL.md not found");
  }

  // Check CLI is available (via uv run from skill directory)
  try {
    const result = await $`cd ${SKILL_DIR} && uv run freshrss --help`.nothrow();
    if (result.exitCode !== 0) {
      errors.push("CLI not available - run 'uv pip install -e .' first");
    }
  } catch {
    errors.push("CLI not available - ensure package is installed");
  }

  // Check Python syntax
  try {
    const result = await $`cd ${SKILL_DIR} && uv run python -m py_compile freshrss/main.py`
      .nothrow();
    if (result.exitCode !== 0) {
      errors.push("Python syntax error in main.py");
    }
  } catch {
    errors.push("Could not run Python syntax check");
  }

  return { ok: errors.length === 0, errors };
}

//
// Run command via CLI (not through pi agent - direct testing)
//
async function runCommand(cmd: string | string[]): Promise<{
  ok: boolean;
  output: string;
}> {
  try {
    const args = Array.isArray(cmd) ? cmd : [cmd];
    const result = await $`cd ${SKILL_DIR} && uv run freshrss ${args}`.nothrow();
    return { ok: result.exitCode === 0, output: result.stdout.toString() };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

//
// Test cases - direct CLI commands to verify functionality
//
const CLI_TESTS: Array<{
  name: string;
  cmd: string[];
  expectExitZero: boolean;
}> = [
  { name: "help", cmd: ["--help"], expectExitZero: true },
  { name: "init help", cmd: ["init", "--help"], expectExitZero: true },
  { name: "unread help", cmd: ["unread", "--help"], expectExitZero: true },
  { name: "read help", cmd: ["read", "--help"], expectExitZero: true },
  { name: "view help", cmd: ["view", "--help"], expectExitZero: true },
  { name: "mark-read help", cmd: ["mark-read", "--help"], expectExitZero: true },
  { name: "health help", cmd: ["health", "--help"], expectExitZero: true },
  { name: "interests help", cmd: ["interests", "--help"], expectExitZero: true },
];

async function runCLITests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const test of CLI_TESTS) {
    const { ok, output } = await runCommand(test.cmd);
    const passed = ok === test.expectExitZero;
    const cmdStr = test.cmd.join(" ");
    results.push({
      name: test.name,
      prompt: cmdStr,
      ok,
      output,
      passed,
      reason: passed
        ? "CLI responded as expected"
        : `Expected exit ${test.expectExitZero ? 0 : "non-zero"}, got ${ok ? 0 : 1}`,
    });
  }

  return results;
}

//
// Print results summary
//
function printResults(results: TestResult[]): void {
  console.log("\n=== Test Results ===\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`${icon} ${r.name}`);
    if (!r.passed) {
      console.log(`  Reason: ${r.reason}`);
      if (r.output.trim()) {
        console.log(`  Output: ${r.output.slice(0, 200)}...`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

//
// Main entry point
//
async function main(): Promise<number> {
  console.log(`Testing ${SKILL_NAME} skill...\n`);

  // Pre-flight
  const preflight = await preflightChecks();
  if (!preflight.ok) {
    console.log("Pre-flight checks failed:");
    for (const err of preflight.errors) {
      console.log(`  - ${err}`);
    }
    console.log("\nRun these from the skill directory:");
    console.log(`  cd ${SKILL_DIR}`);
    console.log("  uv pip install -e .");
    return 1;
  }

  console.log("Pre-flight checks passed\n");

  // Run CLI tests
  const results = await runCLITests();

  // Print summary
  printResults(results);

  const failed = results.filter((r) => !r.passed).length;
  return failed > 0 ? 1 : 0;
}

// Run
const exitCode = await main();
process.exit(exitCode);
