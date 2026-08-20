/** Resolve the child's effective skill allow-list. */
export function resolveSkillAllowList(
	frontmatterSkills: string[] | undefined,
	callSkills: string[] | undefined,
): string[] | undefined {
	// An omitted frontmatter field means normal discovery. Call-level skills are
	// already part of that discovery and must not turn it into a restriction.
	if (frontmatterSkills === undefined) return undefined;

	return Array.from(new Set([...frontmatterSkills, ...(callSkills ?? [])]));
}
