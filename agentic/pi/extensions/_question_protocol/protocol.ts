/**
 * Wire protocol for the `question` tool's parent ↔ child bridge.
 *
 * A subagent runs in a separate `pi` child process with no terminal of its
 * own. When it wants to ask the user a question it cannot open a dialog
 * directly, so the question tool emits a tagged JSON line on stderr; the
 * parent's subagent extension watches for that line, opens the dialog
 * itself, and writes a tagged JSON line back on a dedicated extra pipe
 * (the child finds its read-end fd via `PI_QUESTION_RESPONSE_FD`,
 * typically fd 3). The child's stdin is left attached to /dev/null so it
 * never blocks on startup.
 *
 * The protocol is deliberately tiny and line-based:
 *
 *   child  → parent  (on stderr)
 *     PI_QUESTION_REQUEST <json>\n
 *     where <json> = { id: string, questions: QuestionItem[] }
 *
 *   parent → child   (on the extra response pipe, fd $PI_QUESTION_RESPONSE_FD)
 *     PI_QUESTION_RESPONSE <json>\n
 *     where <json> = { id: string, answers?: string[], error?: string }
 *
 * The line-start tags are very unlikely to occur at the start of normal log
 * lines, and the parent only treats them as protocol when they appear as
 * the first characters of a stderr line.
 *
 * `id` is a short random token so a parent never confuses replies for
 * different in-flight requests (only one is in flight at a time in practice
 * but the id keeps the design honest).
 */

export const REQUEST_TAG = "PI_QUESTION_REQUEST ";
export const RESPONSE_TAG = "PI_QUESTION_RESPONSE ";

export interface QuestionItem {
	question: string;
	options?: string[];
}

export interface QuestionRequest {
	id: string;
	questions: QuestionItem[];
}

export interface QuestionResponse {
	id: string;
	answers?: string[];
	error?: string;
}

export function encodeRequest(req: QuestionRequest): string {
	return `${REQUEST_TAG}${JSON.stringify(req)}\n`;
}

export function encodeResponse(res: QuestionResponse): string {
	return `${RESPONSE_TAG}${JSON.stringify(res)}\n`;
}

export function tryParseRequest(line: string): QuestionRequest | null {
	if (!line.startsWith(REQUEST_TAG)) return null;
	try {
		return JSON.parse(line.slice(REQUEST_TAG.length)) as QuestionRequest;
	} catch {
		return null;
	}
}

export function tryParseResponse(line: string): QuestionResponse | null {
	if (!line.startsWith(RESPONSE_TAG)) return null;
	try {
		return JSON.parse(line.slice(RESPONSE_TAG.length)) as QuestionResponse;
	} catch {
		return null;
	}
}
