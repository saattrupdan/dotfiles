import assert from "node:assert/strict";
import test from "node:test";

import {
	createSubagentLabelCounter,
	formatSubagentMergeCommitMessage,
	formatSubagentSessionLabel,
	normalizeSubagentTaskName,
	SUBAGENT_TASK_NAME_PATTERN,
} from "./session-label.ts";

test("formats child labels from the concrete task name", () => {
	assert.equal(formatSubagentSessionLabel("builder", 2, "Fix parser"), "builder2: Fix parser");
	assert.equal(
		formatSubagentSessionLabel("reviewer", 1, "Review\tparser   fix"),
		"reviewer1: Review parser fix",
	);
});

test("allocates independent ordinals per agent", () => {
	const counter = createSubagentLabelCounter();
	assert.equal(counter.next("builder", "Fix parser"), "builder1: Fix parser");
	assert.equal(counter.next("reviewer", "Review parser"), "reviewer1: Review parser");
	assert.equal(counter.next("builder", "Add tests"), "builder2: Add tests");
});

test("accepts only one to five safe single-line task-name words", () => {
	const pattern = new RegExp(SUBAGENT_TASK_NAME_PATTERN);
	assert.equal(pattern.test("Fix"), true);
	assert.equal(pattern.test("Add short subagent task names"), true);
	assert.equal(pattern.test("Add short subagent task display names"), false);
	assert.equal(pattern.test(" Fix parser"), false);
	assert.equal(pattern.test("Fix parser "), false);
	assert.equal(pattern.test("Fix\tparser"), false);
	assert.equal(pattern.test("Fix\nparser"), false);
	assert.equal(pattern.test("Fix\u001bparser"), false);
	assert.equal(pattern.test("Fix\0parser"), false);
});

test("normalizes task names that bypass schema validation", () => {
	assert.equal(normalizeSubagentTaskName(" Fix\tparser\u001b now "), "Fix parser now");
	assert.equal(normalizeSubagentTaskName("one two three four five six"), "one two three four five");
});

test("formats a descriptive worktree merge subject", () => {
	assert.equal(formatSubagentMergeCommitMessage("builder", "Fix   parser"), "Merge builder: Fix parser");
});
