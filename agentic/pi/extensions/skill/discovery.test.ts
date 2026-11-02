import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { discoverSkills } from "./discovery.ts";

test("discovers skills explicitly selected by the profile launcher", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-discovery-"));
	try {
		const selected = path.join(root, "external");
		fs.mkdirSync(selected);
		fs.writeFileSync(path.join(selected, "SKILL.md"),
			"---\nname: external-test-skill\ndescription: External test skill\n---\n");
		assert.ok(discoverSkills(root, ["--no-skills", "--skill", selected])
			.some((skill) => skill.name === "external-test-skill"));
		assert.ok(!discoverSkills(root, ["--", "--skill", selected])
			.some((skill) => skill.name === "external-test-skill"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
