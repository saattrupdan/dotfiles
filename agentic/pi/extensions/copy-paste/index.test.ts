import { expect, test } from "bun:test";

import {
	createToolResultStore,
	expandToolPlaceholders,
	stripPrependedToolCallIdTag,
	toolCallIdReference,
	toolCallIdTag,
	unresolvedToolPlaceholders,
} from "./index";

test("strips prepended tags for opaque toolCallId strings", () => {
	const id = "call_(bad[+";
	const raw = `[toolCallId: ${id}]\n\npayload`;

	expect(() => stripPrependedToolCallIdTag(raw, id)).not.toThrow();
	expect(stripPrependedToolCallIdTag(raw, id)).toBe("payload");
});

test("strips the tag printed by the reference id", () => {
	const id = "call_abc123|fc_03552ca1db6cf012016a941fbc57d087d2b1f04d4b44ec4f06";
	const raw = `${toolCallIdTag(toolCallIdReference(id))}\npayload`;

	expect(stripPrependedToolCallIdTag(raw, id)).toBe("payload");
});

test("prints only the call_id part of a Responses-API toolCallId", () => {
	expect(toolCallIdReference("call_XfXAkLk472FLQVRGdF5wI1YT|fc_0d1fceddb8664b94016a9664")).toBe(
		"call_XfXAkLk472FLQVRGdF5wI1YT",
	);
	expect(toolCallIdTag("call_XfXAkLk472FLQVRGdF5wI1YT|fc_0d1fceddb8664b94016a9664")).toBe(
		"[toolCallId: call_XfXAkLk472FLQVRGdF5wI1YT]\n",
	);
	expect(toolCallIdReference("chatcmpl-tool-8ddad83a78042f01")).toBe(
		"chatcmpl-tool-8ddad83a78042f01",
	);
});

test("expands placeholders containing full annotated ids", () => {
	const id = [
		"call_e8FRdBRcVf0PQEDBYkCmhOOs|+UAfFpJjt/0s7G1E3NjD0GozLdq+cyXLYHvPiRJUBCrFRBwUKqVZ0q0IyCTvf4Levv3wsKqbk8jBMGKDSTg+7A7UnXivmAdsdiHPVb3axN7CgoqAm9IS/o+96lt1L1QYYe8FgmNiR7YMBehoV+0n05taTpOLjwMBr4pts5OagWfTq5bWPqGrFN8O0QUmOvbLh//ghHog+zPszisGgpHWtiZMjP/k+G0w2q8oYyTe0tIswJYpMLPP3wfjriflGDjH5iYv3/K1J3wE3NM53AG0ufeCQGVryRtwBniACYb94gRzakpYqdAxE0TNGsT6P7SK0lWbyd4kjkKy5MK05X8Dwe4OTWGtPO0mGpwqiUS9pn6fxxRQhQoiIiZStZ3/fF+jY31EoYUNnasRQjC2ssPioA",
		"==",
	].join("");
	const toolResultMap = new Map([
		[id, "captured output"],
		[toolCallIdReference(id), "captured output"],
	]);

	expect(expandToolPlaceholders(`before {tool: ${id}} after`, toolResultMap)).toBe(
		"before captured output after",
	);
});

test("expands a placeholder written with only the call_id part", () => {
	const full = "call_XfXAkLk472FLQVRGdF5wI1YT|fc_0d1fceddb8664b94016a9664f5671487d29ded0d3e2750a3e0";
	const toolResultMap = new Map([
		[full, "7 unsupported files\n"],
		[toolCallIdReference(full), "7 unsupported files\n"],
	]);

	expect(
		expandToolPlaceholders("The files are:\n\n{tool: call_XfXAkLk472FLQVRGdF5wI1YT}", toolResultMap),
	).toBe("The files are:\n\n7 unsupported files\n");
});

test("stores a composite result under both the full and the short id", () => {
	const full = "call_XfXAkLk472FLQVRGdF5wI1YT|fc_0d1fceddb8664b94016a9664f5671487d29ded0d3e2750a3e0";
	const store = createToolResultStore();

	expect(store.tagFor(full)).toBe("[toolCallId: call_XfXAkLk472FLQVRGdF5wI1YT]\n");
	store.remember(full, `[toolCallId: call_XfXAkLk472FLQVRGdF5wI1YT]\n\n7 rejected files\n`);

	expect(expandToolPlaceholders("{tool: call_XfXAkLk472FLQVRGdF5wI1YT}", store.outputs)).toBe(
		"7 rejected files\n",
	);
	expect(expandToolPlaceholders(`{tool: ${full}}`, store.outputs)).toBe("7 rejected files\n");
});

test("tags a later call with its full id when the short handle is taken", () => {
	const first = "call_shared|fc_one";
	const second = "call_shared|fc_two";
	const store = createToolResultStore();

	expect(store.tagFor(first)).toBe("[toolCallId: call_shared]\n");
	expect(store.tagFor(second)).toBe(`[toolCallId: ${second}]\n`);
	store.remember(first, "[toolCallId: call_shared]\n\nfirst output");
	store.remember(second, `[toolCallId: ${second}]\n\nsecond output`);

	expect(expandToolPlaceholders("{tool: call_shared}", store.outputs)).toBe("first output");
	expect(expandToolPlaceholders(`{tool: ${second}}`, store.outputs)).toBe("second output");
});

test("reports which placeholders could not be resolved", () => {
	const store = createToolResultStore();
	store.remember("call_known|fc_item", "[toolCallId: call_known]\n\ndone");

	expect(
		unresolvedToolPlaceholders("{tool: call_known} {tool: call_missing}", store.outputs),
	).toEqual(["call_missing"]);
});

test("leaves unknown placeholders unchanged", () => {
	expect(expandToolPlaceholders("{tool: missing|+/=}", new Map())).toBe(
		"{tool: missing|+/=}",
	);
});
