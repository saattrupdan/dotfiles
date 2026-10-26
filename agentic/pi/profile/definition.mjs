/* Shared frontmatter validation for top-level profiles and subagents. */

const NAME = /^[a-z][a-z0-9-]*$/;

function stringList(raw, field, filePath) {
	if (raw === undefined) return undefined;
	const items = typeof raw === "string" ? raw.split(",").map((item) => item.trim()) : raw;
	if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${filePath}: ${field} must be a comma-separated string or a list of nonempty strings`);
	}
	return items.map((item) => item.trim());
}

export function parseAgentProfile(frontmatter, body, filePath, source = "user") {
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		throw new Error(`${filePath}: agent frontmatter must be a mapping`);
	}
	const { name, description } = frontmatter;
	if (typeof name !== "string" || !NAME.test(name)) {
		throw new Error(`${filePath}: name must contain only lowercase letters, digits and hyphens`);
	}
	if (typeof description !== "string" || !description.trim()) {
		throw new Error(`${filePath}: description must be a nonempty string`);
	}
	for (const field of ["subagent", "worktree"]) {
		if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean") {
			throw new Error(`${filePath}: ${field} must be true or false`);
		}
	}
	const tools = stringList(frontmatter.tools, "tools", filePath);
	// Pi's +name/-name and wildcard syntax modifies defaults instead of narrowing them.
	if (tools?.some((name) => !/^[a-z_][A-Za-z0-9_-]*$/.test(name))) {
		throw new Error(`${filePath}: tools must be literal tool names, not patterns or modifiers`);
	}
	const skills = stringList(frontmatter.skills, "skills", filePath);
	const extensions = stringList(frontmatter.extensions, "extensions", filePath);
	for (const [field, items] of [["skills", skills], ["extensions", extensions]]) {
		if (items?.some((item) => !NAME.test(item))) {
			throw new Error(`${filePath}: ${field} entries must be simple names, not paths`);
		}
	}
	const model = stringList(frontmatter.model, "model", filePath);
	const refuse = frontmatter.refuse;
	if (refuse !== undefined && !Array.isArray(refuse)) {
		throw new Error(`${filePath}: refuse must be a list`);
	}
	const rules = refuse?.map((rule) => {
		if (!rule || typeof rule !== "object" || typeof rule.pattern !== "string" ||
			typeof rule.message !== "string" || (rule.flags !== undefined && typeof rule.flags !== "string")) {
			throw new Error(`${filePath}: each refuse entry needs a pattern and message`);
		}
		new RegExp(rule.pattern, rule.flags ?? "i");
		return { pattern: rule.pattern, message: rule.message, ...(rule.flags ? { flags: rule.flags } : {}) };
	});
	if (typeof body !== "string" || !body.trim()) {
		throw new Error(`${filePath}: agent prompt must not be empty`);
	}
	return {
		name,
		description: description.trim(),
		subagent: frontmatter.subagent ?? true, // Existing project agents remain delegatable.
		tools,
		model: model?.length ? model : undefined,
		worktree: frontmatter.worktree ?? false,
		skills,
		extensions,
		refuse: rules,
		systemPrompt: body,
		source,
		filePath,
	};
}
