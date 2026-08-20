import { expect, test } from "bun:test";

import { resolveSkillAllowList } from "./skill-scope.ts";

test("keeps normal discovery when frontmatter omits skills", () => {
	expect(resolveSkillAllowList(undefined, ["python"])).toBeUndefined();
});

test("adds per-call skills to an explicit empty allow-list", () => {
	expect(resolveSkillAllowList([], ["python", "fastapi"])).toEqual(["python", "fastapi"]);
});

test("unions and deduplicates explicit and per-call skills", () => {
	expect(resolveSkillAllowList(["python", "commit"], ["python", "fastapi", "commit"])).toEqual([
		"python",
		"commit",
		"fastapi",
	]);
});

test("preserves an explicit allow-list when no skills are passed", () => {
	expect(resolveSkillAllowList(["python", "commit"], undefined)).toEqual(["python", "commit"]);
});
