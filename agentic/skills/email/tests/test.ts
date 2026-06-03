#!/usr/bin/env bun
/**
 * Test suite for email skill
 * 
 * Tests CLI help commands and structure
 * Requires: email CLI on PATH, skill file exists, Python linting passes
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const PYPROJECT_FILE = join(SKILL_DIR, "pyproject.toml");
const CLI_NAME = "email";

const HELP_COMMANDS = [
  `${CLI_NAME} --help`,
  `${CLI_NAME} list --help`,
  `${CLI_NAME} read --help`,
  `${CLI_NAME} send --help`,
];

async function prefightChecks(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Check skill file exists
  try {
    readFileSync(SKILL_FILE, "utf-8");
  } catch {
    errors.push(`Skill file not found: ${SKILL_FILE}`);
  }

  // Check CLI is installed
  try {
    await $`which ${CLI_NAME}`.quiet();
  } catch {
    errors.push(`${CLI_NAME} CLI not found on PATH`);
  }

  // Check CLI responds to --help
  try {
    await $`${CLI_NAME} --help`.quiet();
  } catch {
    errors.push(`${CLI_NAME} CLI failed to respond to --help`);
  }

  // Python linting — format check
  try {
    await $`uv run ruff format --check email_cli/`.cwd(SKILL_DIR).quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }

  // Python linting — lint check
  try {
    await $`uv run ruff check email_cli/`.cwd(SKILL_DIR).quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }

  return { ok: errors.length === 0, errors };
}

async function runHelpCommand(cmd: string): Promise<{ success: boolean; output: string }> {
  try {
    // Bun's $ requires template literal syntax, so we use bash -c to execute the command string
    const result = await $`bash -c ${cmd}`.text();
    return { success: true, output: result.trim() };
  } catch (error: any) {
    return { 
      success: false, 
      output: error?.stderr?.toString()?.trim() || error?.message || "Unknown error" 
    };
  }
}

function validateHelpOutput(output: string, expectedKeywords: string[]): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const keyword of expectedKeywords) {
    if (!output.toLowerCase().includes(keyword.toLowerCase())) {
      missing.push(keyword);
    }
  }
  return { valid: missing.length === 0, missing };
}

async function testHelpCommands(): Promise<Array<{ command: string; passed: boolean; reason: string }>> {
  const results: Array<{ command: string; passed: boolean; reason: string }> = [];

  const testCases = [
    { command: `${CLI_NAME} --help`, keywords: ["accounts", "login", "list", "read", "send"] },
    { command: `${CLI_NAME} list --help`, keywords: ["folder", "query", "unread", "limit"] },
    { command: `${CLI_NAME} read --help`, keywords: ["id", "mark-read", "html"] },
    { command: `${CLI_NAME} send --help`, keywords: ["to", "subject", "body", "confirm"] },
  ];

  for (const testCase of testCases) {
    console.log(`  Testing: ${testCase.command}`);
    const { success, output } = await runHelpCommand(testCase.command);

    if (!success) {
      results.push({
        command: testCase.command,
        passed: false,
        reason: `Command failed: ${output.slice(0, 100)}`,
      });
      continue;
    }

    const { valid, missing } = validateHelpOutput(output, testCase.keywords);
    if (valid) {
      results.push({
        command: testCase.command,
        passed: true,
        reason: "OK",
      });
    } else {
      results.push({
        command: testCase.command,
        passed: false,
        reason: `Missing expected keywords: ${missing.join(", ")}`,
      });
    }
  }

  return results;
}

function printResults(results: Array<{ command: string; passed: boolean; reason: string }>): void {
  console.log("\n" + "=".repeat(60));
  console.log("Test Results");
  console.log("=".repeat(60));

  let passCount = 0;
  for (const result of results) {
    const icon = result.passed ? "✓" : "✗";
    console.log(`${icon} ${result.command}`);
    if (!result.passed) {
      console.log(`  → ${result.reason}`);
    }
    if (result.passed) passCount++;
  }

  console.log(`\nPassed: ${passCount}/${results.length}`);
}

async function main() {
  console.log(`Testing ${CLI_NAME} skill\n`);

  // Pre-flight checks
  console.log("Running pre-flight checks...");
  const preflight = await prefightChecks();
  if (!preflight.ok) {
    console.error("\nPre-flight checks failed:");
    for (const error of preflight.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("Pre-flight checks passed ✓\n");

  // Run help command tests
  console.log("Testing help commands...");
  const results = await testHelpCommands();
  printResults(results);

  // Final verdict
  const allPassed = results.every(r => r.passed);
  console.log("\n" + "=".repeat(60));
  if (allPassed) {
    console.log(`✓✓✓ ${CLI_NAME} SKILL APPROVED ✓✓✓`);
    console.log("=".repeat(60) + "\n");
    process.exit(0);
  } else {
    console.log(`✗✗✗ ${CLI_NAME} SKILL FAILED ✗✗✗`);
    console.log("=".repeat(60) + "\n");
    process.exit(1);
  }
}

main();
