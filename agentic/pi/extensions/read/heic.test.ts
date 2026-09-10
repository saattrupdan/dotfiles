import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import registerRead from "./index.ts";
import {
	buildHeicConversionCandidates,
	convertHeicToJpeg,
	getHeifPrimaryRotation,
	isHeifImage,
	type ConversionStep,
} from "./heic.ts";

function box(type: string, payload: Buffer): Buffer {
	const result = Buffer.alloc(8 + payload.length);
	result.writeUInt32BE(result.length, 0);
	result.write(type, 4, 4, "ascii");
	payload.copy(result, 8);
	return result;
}

function extendedBox(type: string, payload: Buffer): Buffer {
	const result = Buffer.alloc(16 + payload.length);
	result.writeUInt32BE(1, 0);
	result.write(type, 4, 4, "ascii");
	result.writeBigUInt64BE(BigInt(result.length), 8);
	payload.copy(result, 16);
	return result;
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(4);
	header[0] = version;
	header.writeUIntBE(flags, 1, 3);
	return box(type, Buffer.concat([header, payload]));
}

function ftypPayload(majorBrand = "heic", minorVersion = Buffer.alloc(4)): Buffer {
	return Buffer.concat([
		Buffer.from(majorBrand, "ascii"),
		minorVersion,
		Buffer.from("mif1heic", "ascii"),
	]);
}

function ipmaEntry(itemId: number, propertyIndex: number): Buffer {
	const entry = Buffer.alloc(4);
	entry.writeUInt16BE(itemId, 0);
	entry[2] = 1;
	entry[3] = propertyIndex;
	return entry;
}

function ipma(entries: Buffer[]): Buffer {
	const count = Buffer.alloc(4);
	count.writeUInt32BE(entries.length);
	return fullBox("ipma", 0, 0, Buffer.concat([count, ...entries]));
}

function heifWithPrimaryRotation(rotation: number): Buffer {
	const ftyp = box("ftyp", ftypPayload());
	const primaryId = 7;
	const thumbnailId = 8;
	const pitmPayload = Buffer.alloc(2);
	pitmPayload.writeUInt16BE(primaryId);
	const pitm = fullBox("pitm", 0, 0, pitmPayload);
	const ipco = box("ipco", Buffer.concat([
		box("irot", Buffer.from([0])),
		box("irot", Buffer.from([rotation])),
	]));
	const iprp = box("iprp", Buffer.concat([
		ipco,
		ipma([ipmaEntry(thumbnailId, 1)]),
		ipma([ipmaEntry(primaryId, 2)]),
	]));
	const meta = fullBox("meta", 0, 0, Buffer.concat([pitm, iprp]));
	return Buffer.concat([ftyp, meta]);
}

function tempHeif(rotation = 0): { root: string; source: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-heic-test-"));
	const source = path.join(root, "source.heic");
	fs.writeFileSync(source, heifWithPrimaryRotation(rotation));
	return { root, source };
}

function jpegFixture(): Buffer {
	return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function outputPath(step: ConversionStep): string {
	const output = step.args.at(-1);
	assert.ok(output);
	return output;
}

test("recognizes normal and extended HEIF file-type boxes", () => {
	assert.equal(isHeifImage(heifWithPrimaryRotation(0)), true);
	assert.equal(isHeifImage(extendedBox("ftyp", ftypPayload())), true);
	assert.equal(isHeifImage(Buffer.from("not a HEIF image")), false);
});

test("does not treat the ftyp minor version as a compatible brand", () => {
	const spoofed = box("ftyp", ftypPayload("test", Buffer.from("heic", "ascii")).subarray(0, 8));
	assert.equal(isHeifImage(spoofed), false);
});

test("resolves primary rotation from a later ipma box", () => {
	assert.equal(getHeifPrimaryRotation(heifWithPrimaryRotation(3)), 3);
});

test("maps HEIF counter-clockwise rotation to sips clockwise rotation", () => {
	const candidates = buildHeicConversionCandidates("photo.heic", "photo.jpg", 3, "darwin");
	assert.deepEqual(candidates[0], [
		{
			command: "/usr/bin/sips",
			args: ["-s", "format", "jpeg", "-s", "formatOptions", "90", "photo.heic", "--out", "photo.jpg"],
		},
		{ command: "/usr/bin/sips", args: ["-r", "90", "photo.jpg"] },
	]);
});

test("offers portable non-macOS converter fallbacks", () => {
	const candidates = buildHeicConversionCandidates("photo.heif", "photo.jpg", null, "linux");
	assert.deepEqual(candidates.map((steps) => steps[0]?.command), ["magick", "heif-convert"]);
});

test("falls back after a converter failure and cleans temporary output", async () => {
	const { root, source } = tempHeif();
	const commands: string[] = [];
	try {
		const converted = await convertHeicToJpeg(source, undefined, {
			platform: "linux",
			tempRoot: root,
			runCommand: async (step) => {
				commands.push(step.command);
				if (step.command === "magick") return { status: 1, stderr: "failed" };
				fs.writeFileSync(outputPath(step), jpegFixture());
				return { status: 0, stderr: "" };
			},
		});
		assert.deepEqual(converted, jpegFixture());
		assert.deepEqual(commands, ["magick", "heif-convert"]);
		assert.deepEqual(fs.readdirSync(root), ["source.heic"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("rejects invalid converter output and cleans each attempt", async () => {
	const { root, source } = tempHeif();
	try {
		await assert.rejects(
			convertHeicToJpeg(source, undefined, {
				platform: "linux",
				tempRoot: root,
				runCommand: async (step) => {
					fs.writeFileSync(outputPath(step), "not jpeg");
					return { status: 0, stderr: "" };
				},
			}),
			/no working HEIC converter found/,
		);
		assert.deepEqual(fs.readdirSync(root), ["source.heic"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("abort stops fallback attempts and cleans temporary output", async () => {
	const { root, source } = tempHeif();
	const controller = new AbortController();
	const commands: string[] = [];
	try {
		await assert.rejects(
			convertHeicToJpeg(source, controller.signal, {
				platform: "linux",
				tempRoot: root,
				runCommand: async (step) => {
					commands.push(step.command);
					controller.abort();
					throw new Error("stopped");
				},
			}),
			/HEIC conversion aborted/,
		);
		assert.deepEqual(commands, ["magick"]);
		assert.deepEqual(fs.readdirSync(root), ["source.heic"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("registered read tool returns converted HEIC as JPEG content", async () => {
	const { root, source } = tempHeif();
	let registered: {
		execute(
			toolCallId: string,
			params: { path: string },
			signal: AbortSignal,
			onUpdate: () => void,
			ctx: { cwd: string },
		): Promise<{ content: Array<{ type: string; mimeType?: string; data?: string }> }>;
	} | undefined;
	try {
		registerRead({
			registerTool(tool: unknown) {
				registered = tool as typeof registered;
			},
		} as never, {
			convertHeic: async () => jpegFixture(),
		});
		assert.ok(registered);
		const result = await registered.execute(
			"test",
			{ path: source },
			new AbortController().signal,
			() => undefined,
			{ cwd: process.cwd() },
		);
		assert.deepEqual(result.content, [{
			type: "image",
			data: jpegFixture().toString("base64"),
			mimeType: "image/jpeg",
		}]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
