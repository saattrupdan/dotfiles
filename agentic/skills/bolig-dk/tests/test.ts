#!/usr/bin/env bun
/**
 * Test suite for bolig-dk skill
 * 
 * Runs test prompts, evaluates responses, requires 3 consecutive clean runs
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "bolig-dk";

/**
 * Test prompts — each should trigger the bolig-dk skill and exercise specific functionality
 * Mix of English and Danish prompts, written as natural user questions
 * All include explicit Danish context (cities, sites, currency) to ensure skill triggers
 */
const TEST_PROMPTS: string[] = [
  // === ENGLISH PROMPTS ===
  
  "I need a rental apartment in Frederiksberg with a bathtub",
  "Looking for a place to rent in Copenhagen, max 10,000 kr per month",
  "Do you know any shared flats or rooms in Aarhus via boligportal.dk?",
  "Can I find pet-friendly rentals on boligportal.dk?",
  "I want to buy a house in Odense, budget around 3 million kr",
  "Are there any apartments for sale in Copenhagen with an elevator?",
  "Which real estate agencies operate in Gentofte (boligsiden.dk)?",
  "Find rentals on boligportal.dk mentioning a bathtub in the description",
  "I'm looking for a house with a garden for sale in Denmark",
  "What rental property types are available on boligportal.dk?",
  "How do I look up specific addresses on boligsiden.dk?",
  
  // === DANISH PROMPTS ===
  
  "Jeg leder efter en lejebolig i Frederiksberg med badekar",
  "Find en bolig til leje i København, maks 10.000 kr om måneden",
  "Ved du nogle ledige værelser i Aarhus på boligportal.dk?",
  "Kan man finde husdyr-venlige boliger på boligportal.dk?",
  "Jeg vil købe hus i Odense, budget omkring 3 millioner kr",
  "Er der nogen lejligheder til salg i København med elevator på boligsiden.dk?",
  "Hvilke ejendomsmæglere er der i Gentofte ifølge boligsiden.dk?",
  "Find lejeboliger på boligportal.dk hvor der står 'badekar' i annoncen",
  "Jeg leder efter et hus med have til salg i Danmark",
  "Hvad kan man søge efter af boligtyper til leje på boligportal.dk?",
  "Hvordan slår jeg en adresse op på boligsiden.dk?",
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
    await $`which bolig`.quiet();
  } catch {
    errors.push("bolig CLI not found on PATH");
  }
  
  // Check CLI responds to --help
  try {
    await $`bolig --help`.quiet();
  } catch {
    errors.push("bolig CLI failed to respond to --help");
  }
  
  // Python linting — format check
  try {
    await $`uv run ruff format --check bolig_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff format check");
  }
  
  // Python linting — lint check
  try {
    await $`uv run ruff check bolig_dk/`.quiet();
  } catch {
    errors.push("Python code failed ruff lint check");
  }
  
  return { ok: errors.length === 0, errors };
}

/**
 * Run a single test prompt through pi
 */
async function runPrompt(prompt: string): Promise<string> {
  const result = await $`pi -p "${prompt}"`.text();
  return result.trim();
}

/**
 * Evaluate test results using the model
 * Returns array of { prompt, response, passed, reason }
 */
async function evaluateResults(
  skillContent: string,
  results: Array<{ prompt: string; response: string }>
): Promise<Array<{ prompt: string; response: string; passed: boolean; reason: string }>> {
  const evalPrompt = `You are evaluating test results for the ${SKILL_NAME} skill.

## Skill Content
${skillContent}

## Test Results
${results.map((r, i) => `### Test ${i + 1}
**Prompt:** ${r.prompt}
**Response:** ${r.response}`).join("\n\n")}

## Evaluation Criteria
For each test, check:
1. ✓ Used the bolig-dk skill (loaded it or referenced bolig CLI)
2. ✓ Followed the skill's procedural guidance
3. ✓ Called the correct CLI command with valid arguments
4. ✓ Referenced correct APIs/endpoints (boligportal.dk for rent, api.boligsiden.dk for buy)
5. ✓ Did not hallucinate endpoints or command flags
6. ✓ Handled errors gracefully if applicable

## Output Format
Respond with a JSON array, one object per test:
[
  {"test": 1, "passed": true, "reason": "brief explanation"},
  {"test": 2, "passed": false, "reason": "what went wrong"}
]

Respond ONLY with the JSON array, no other text.`;

  const result = await $`pi -p "${evalPrompt}"`.text();
  
  // Parse JSON from response
  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Evaluator did not return valid JSON: ${result}`);
  }
  
  const evaluations = JSON.parse(jsonMatch[0]) as Array<{
    test: number;
    passed: boolean;
    reason: string;
  }>;
  
  return evaluations.map((eval_, i) => ({
    prompt: results[i].prompt,
    response: results[i].response,
    passed: eval_.passed,
    reason: eval_.reason,
  }));
}

/**
 * Run one complete test iteration
 */
async function runTestIteration(): Promise<{
  passed: boolean;
  results: Array<{ prompt: string; response: string; passed: boolean; reason: string }>;
}> {
  console.log("\n--- Running test iteration ---\n");
  
  // Run all prompts
  const results: Array<{ prompt: string; response: string }> = [];
  for (const prompt of TEST_PROMPTS) {
    process.stdout.write(`Running: ${prompt.slice(0, 60)}... `);
    const response = await runPrompt(prompt);
    results.push({ prompt, response });
    process.stdout.write("done\n");
  }
  
  // Evaluate
  console.log("\nEvaluating results...\n");
  const skillContent = readFileSync(SKILL_FILE, "utf-8");
  const evaluated = await evaluateResults(skillContent, results);
  
  const passed = evaluated.every(r => r.passed);
  return { passed, results: evaluated };
}

/**
 * Print test results summary
 */
function printResults(
  results: Array<{ prompt: string; response: string; passed: boolean; reason: string }>
) {
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS");
  console.log("=".repeat(60));
  
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  
  console.log(`\nPassed: ${passedCount}/${totalCount}\n`);
  
  for (const result of results) {
    const symbol = result.passed ? "✓" : "✗";
    console.log(`${symbol} ${result.prompt.slice(0, 50)}${result.prompt.length > 50 ? "..." : ""}`);
    if (!result.passed) {
      console.log(`  Reason: ${result.reason}`);
      console.log(`  Response preview: ${result.response.slice(0, 200)}${result.response.length > 200 ? "..." : ""}\n`);
    }
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
  
  // Run 3 iterations, requiring 100% pass each time
  const MAX_ITERATIONS = 3;
  let consecutivePasses = 0;
  
  while (consecutivePasses < MAX_ITERATIONS) {
    console.log(`\n>>> Iteration ${consecutivePasses + 1}/${MAX_ITERATIONS}`);
    
    try {
      const iterationResult = await runTestIteration();
      printResults(iterationResult.results);
      
      if (iterationResult.passed) {
        consecutivePasses++;
        console.log(`\n✓ Iteration ${consecutivePasses} passed\n`);
      } else {
        console.log(`\n✗ Iteration ${consecutivePasses + 1} failed — resetting counter\n`);
        consecutivePasses = 0;
      }
    } catch (error) {
      console.error(`\n✗ Iteration ${consecutivePasses + 1} error:`, error);
      consecutivePasses = 0;
    }
  }
  
  console.log("\n" + "=".repeat(60));
  console.log(`✓✓✓ ${SKILL_NAME} SKILL APPROVED (3/3 clean runs) ✓✓✓`);
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
