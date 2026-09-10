import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HEIF_BRANDS = new Set([
	"heic",
	"heix",
	"hevc",
	"hevx",
	"heim",
	"heis",
	"hevm",
	"hevs",
	"mif1",
	"msf1",
]);

interface IsoBox {
	type: string;
	dataStart: number;
	end: number;
}

export interface ConversionStep {
	command: string;
	args: string[];
}

export interface CommandResult {
	status: number;
	stderr: string;
}

export interface HeicConversionOptions {
	platform?: NodeJS.Platform;
	runCommand?: (step: ConversionStep, signal?: AbortSignal) => Promise<CommandResult>;
	tempRoot?: string;
}

/** Return true when a buffer starts with an ISO-BMFF HEIF file-type box. */
export function isHeifImage(buffer: Buffer): boolean {
	if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return false;
	const shortSize = buffer.readUInt32BE(0);
	let headerSize = 8;
	let declaredSize = shortSize;
	if (shortSize === 1) {
		if (buffer.length < 24) return false;
		const largeSize = buffer.readBigUInt64BE(8);
		if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
		declaredSize = Number(largeSize);
		headerSize = 16;
	} else if (shortSize === 0) {
		declaredSize = buffer.length;
	}
	const dataStart = headerSize;
	if (declaredSize < dataStart + 8 || buffer.length < dataStart + 8) return false;
	const end = Math.min(declaredSize, buffer.length);
	if (HEIF_BRANDS.has(buffer.toString("ascii", dataStart, dataStart + 4))) return true;
	// Skip the four-byte minor version between the major and compatible brands.
	for (let offset = dataStart + 8; offset + 4 <= end; offset += 4) {
		if (HEIF_BRANDS.has(buffer.toString("ascii", offset, offset + 4))) return true;
	}
	return false;
}

function readBoxes(buffer: Buffer, start: number, end: number): IsoBox[] {
	const boxes: IsoBox[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		let headerSize = 8;
		if (size === 1) {
			if (offset + 16 > end) break;
			const largeSize = buffer.readBigUInt64BE(offset + 8);
			if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
			size = Number(largeSize);
			headerSize = 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < headerSize || offset + size > end) break;
		boxes.push({ type, dataStart: offset + headerSize, end: offset + size });
		offset += size;
	}
	return boxes;
}

function primaryItemId(buffer: Buffer, pitm: IsoBox): number | null {
	if (pitm.dataStart + 6 > pitm.end) return null;
	const version = buffer[pitm.dataStart];
	const offset = pitm.dataStart + 4;
	if (version === 0) return buffer.readUInt16BE(offset);
	if (offset + 4 <= pitm.end) return buffer.readUInt32BE(offset);
	return null;
}

function propertyAssociations(buffer: Buffer, ipma: IsoBox): Map<number, number[]> {
	const result = new Map<number, number[]>();
	if (ipma.dataStart + 8 > ipma.end) return result;
	const version = buffer[ipma.dataStart];
	const flags = buffer.readUIntBE(ipma.dataStart + 1, 3);
	let offset = ipma.dataStart + 4;
	const entryCount = buffer.readUInt32BE(offset);
	offset += 4;
	for (let entry = 0; entry < entryCount; entry += 1) {
		const idSize = version < 1 ? 2 : 4;
		if (offset + idSize + 1 > ipma.end) break;
		const itemId = idSize === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt32BE(offset);
		offset += idSize;
		const associationCount = buffer[offset] ?? 0;
		offset += 1;
		const propertyIndexes: number[] = [];
		for (let association = 0; association < associationCount; association += 1) {
			const associationSize = flags & 1 ? 2 : 1;
			if (offset + associationSize > ipma.end) break;
			const value = associationSize === 2 ? buffer.readUInt16BE(offset) : buffer[offset]!;
			offset += associationSize;
			const propertyIndex = value & (associationSize === 2 ? 0x7fff : 0x7f);
			if (propertyIndex > 0) propertyIndexes.push(propertyIndex);
		}
		result.set(itemId, propertyIndexes);
	}
	return result;
}

/**
 * Read the primary image item's HEIF `irot` property.
 *
 * The returned value is the number of 90-degree counter-clockwise rotations
 * specified by HEIF, or null when the metadata cannot be resolved.
 */
export function getHeifPrimaryRotation(buffer: Buffer): number | null {
	const meta = readBoxes(buffer, 0, buffer.length).find((box) => box.type === "meta");
	if (!meta || meta.dataStart + 4 > meta.end) return null;
	const metaChildren = readBoxes(buffer, meta.dataStart + 4, meta.end);
	const pitm = metaChildren.find((box) => box.type === "pitm");
	const iprp = metaChildren.find((box) => box.type === "iprp");
	if (!pitm || !iprp) return null;
	const itemId = primaryItemId(buffer, pitm);
	if (itemId === null) return null;

	const propertyBoxes = readBoxes(buffer, iprp.dataStart, iprp.end);
	const ipco = propertyBoxes.find((box) => box.type === "ipco");
	if (!ipco) return null;
	const properties = readBoxes(buffer, ipco.dataStart, ipco.end);
	for (const ipma of propertyBoxes.filter((box) => box.type === "ipma")) {
		const associations = propertyAssociations(buffer, ipma).get(itemId) ?? [];
		for (const propertyIndex of associations) {
			const property = properties[propertyIndex - 1];
			if (property?.type === "irot" && property.dataStart < property.end) {
				return (buffer[property.dataStart] ?? 0) & 0x03;
			}
		}
	}
	return null;
}

/** Build portable HEIC-to-JPEG command fallbacks in preference order. */
export function buildHeicConversionCandidates(
	inputPath: string,
	outputPath: string,
	rotation: number | null,
	platform = process.platform,
): ConversionStep[][] {
	const candidates: ConversionStep[][] = [];
	if (platform === "darwin") {
		const sipsSteps: ConversionStep[] = [{
			command: "/usr/bin/sips",
			args: ["-s", "format", "jpeg", "-s", "formatOptions", "90", inputPath, "--out", outputPath],
		}];
		if (rotation && rotation > 0) {
			const degreesClockwise = ((4 - rotation) % 4) * 90;
			sipsSteps.push({ command: "/usr/bin/sips", args: ["-r", String(degreesClockwise), outputPath] });
		}
		candidates.push(sipsSteps);
	}
	candidates.push([
		{ command: "magick", args: [inputPath, "-auto-orient", "-quality", "90", outputPath] },
	]);
	candidates.push([
		{ command: "heif-convert", args: ["-q", "90", inputPath, outputPath] },
	]);
	return candidates;
}

function runCommand(step: ConversionStep, signal?: AbortSignal): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("HEIC conversion aborted"));
			return;
		}
		const proc = spawn(step.command, step.args, { stdio: ["ignore", "ignore", "pipe"] });
		const stderr: Buffer[] = [];
		let settled = false;
		const onAbort = () => proc.kill();
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		proc.on("close", (code) => finish(() => resolve({ status: code ?? 1, stderr: Buffer.concat(stderr).toString() })));
		proc.on("error", (error) => finish(() => reject(error)));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Convert HEIC/HEIF bytes to an orientation-corrected JPEG image block. */
export async function convertHeicToJpeg(
	filePath: string,
	signal?: AbortSignal,
	options: HeicConversionOptions = {},
): Promise<Buffer> {
	const source = fs.readFileSync(filePath);
	const rotation = getHeifPrimaryRotation(source);
	const tmpDir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "pi-read-heic-"));
	const outputPath = path.join(tmpDir, "converted.jpg");
	const failures: string[] = [];
	const commandRunner = options.runCommand ?? runCommand;
	try {
		for (const steps of buildHeicConversionCandidates(filePath, outputPath, rotation, options.platform)) {
			try {
				for (const step of steps) {
					const result = await commandRunner(step, signal);
					if (result.status !== 0) {
						throw new Error(`${step.command} exited ${result.status}${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : ""}`);
					}
				}
				const converted = fs.readFileSync(outputPath);
				if (converted[0] === 0xff && converted[1] === 0xd8) return converted;
				throw new Error("converter produced no JPEG output");
			} catch (error) {
				if (signal?.aborted) throw new Error("HEIC conversion aborted", { cause: error });
				failures.push((error as Error).message);
				try {
					fs.rmSync(outputPath, { force: true });
				} catch {
					/* continue to the next converter */
				}
			}
		}
		throw new Error(
			`no working HEIC converter found (install ImageMagick or libheif on non-macOS systems): ${failures.join("; ")}`,
		);
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore temporary-file cleanup errors */
		}
	}
}
