import { expect, test } from "bun:test";

import {
	expandToolPlaceholders,
	stripPrependedToolCallIdTag,
} from "./index";

test("strips prepended tags for opaque toolCallId strings", () => {
	const id = "call_(bad[+";
	const raw = `[toolCallId: ${id}]\n\npayload`;

	expect(() => stripPrependedToolCallIdTag(raw, id)).not.toThrow();
	expect(stripPrependedToolCallIdTag(raw, id)).toBe("payload");
});

test("expands placeholders containing full annotated ids", () => {
	const id = [
		"call_e8FRdBRcVf0PQEDBYkCmhOOs|+UAfFpJjt/0s7G1E3NjD0GozLdq+cyXLYHvPiRJUBCrFRBwUKqVZ0q0IyCTvf4Levv3wsKqbk8jBMGKDSTg+7A7UnXivmAdsdiHPVb3axN7CgoqAm9IS/o+96lt1L1QYYe8FgmNiR7YMBehoV+0n05taTpOLjwMBr4pts5OagWfTq5bWPqGrFN8O0QUmOvbLh//ghHog+zPszisGgpHWtiZMjP/k+G0w2q8oYyTe0tIswJYpMLPP3wfjriflGDjH5iYv3/K1J3wE3NM53AG0ufeCQGVryRtwBniACYb94gRzakpYqdAxE0TNGsT6P7SK0lWbyd4kjkKy5MK05X8Dwe4OTWGtPO0mGpwqiUS9pn6fxxRQhQoiIiZStZ3/fF+jY31EoYUNnasRQjC2ssPioA",
		"==",
	].join("");
	const toolResultMap = new Map([[id, "captured output"]]);

	expect(expandToolPlaceholders(`before {tool: ${id}} after`, toolResultMap)).toBe(
		"before captured output after",
	);
});

test("leaves unknown placeholders unchanged", () => {
	expect(expandToolPlaceholders("{tool: missing|+/=}", new Map())).toBe(
		"{tool: missing|+/=}",
	);
});
