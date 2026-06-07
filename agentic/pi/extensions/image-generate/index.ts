/**
 * Image generation tool — wires to Python Stable Diffusion backend.
 *
 * Spawns `generate.py` as a subprocess with prompt and optional parameters,
 * captures stdout/stderr, and returns the generated image path on success.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Tool schema for image generation */
interface ImageGenerateArgs {
	/** Text prompt describing the image to generate */
	prompt: string;
	/** Output image width in pixels (default: 512) */
	width?: number;
	/** Output image height in pixels (default: 512) */
	height?: number;
	/** Number of inference steps (default: 50) */
	steps?: number;
	/** HuggingFace model identifier (default: stable-diffusion-2-1-base) */
	model?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: 'image_generate',
		description:
			'Generate an image from a text prompt using Stable Diffusion. Returns the path to the generated image.',
		parameters: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description: 'Text prompt describing the image to generate',
				},
				width: {
					type: 'number',
					description: 'Output image width in pixels (default: 512)',
				},
				height: {
					type: 'number',
					description: 'Output image height in pixels (default: 512)',
				},
				steps: {
					type: 'number',
					description: 'Number of inference steps (default: 50)',
				},
				model: {
					type: 'string',
					description:
						'HuggingFace model identifier (default: stable-diffusion-2-1-base)',
				},
			},
			required: ['prompt'],
			additionalProperties: false,
		},
		handler: async (args: ImageGenerateArgs) => {
			const pythonScript = join(__dirname, 'generate.py');
			const pythonArgs = [pythonScript, args.prompt];

			// Add optional parameters
			if (args.width !== undefined) {
				pythonArgs.push('--width', String(args.width));
			}
			if (args.height !== undefined) {
				pythonArgs.push('--height', String(args.height));
			}
			if (args.steps !== undefined) {
				pythonArgs.push('--steps', String(args.steps));
			}
			if (args.model !== undefined) {
				pythonArgs.push('--model', args.model);
			}

			return new Promise<{ success: boolean; result?: string; error?: string }>(
				(resolve) => {
					let stdout = '';
					let stderr = '';

					const proc = spawn('uv', ['run', ...pythonArgs], {
						cwd: __dirname,
						stdio: ['ignore', 'pipe', 'pipe'],
					});

					proc.stdout.on('data', (data) => {
						stdout += data.toString('utf8');
					});

					proc.stderr.on('data', (data) => {
						stderr += data.toString('utf8');
					});

					proc.on('close', (code) => {
						if (code === 0) {
							// Python script logs the output path on success
							// Extract it from stdout
							const match = stdout.match(/Image saved to: (.+)$/m);
							if (match) {
								resolve({ success: true, result: match[1].trim() });
							} else {
								resolve({
									success: false,
									error: 'Image generation succeeded but output path not found in response',
								});
							}
						} else {
							resolve({
								success: false,
								error: `Image generation failed (exit code ${code}): ${stderr.trim() || stdout.trim()}`,
							});
						}
					});

					proc.on('error', (err) => {
						resolve({
							success: false,
							error: `Failed to spawn Python process: ${err.message}`,
						});
					});
				},
			);
		},
	});
}
