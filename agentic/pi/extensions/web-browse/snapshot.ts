import type { WebDriver, WebElement } from "selenium-webdriver";

const MAX_ELEMENTS = 250;
const MAX_PAGE_TEXT = 12_000;
const MAX_SNAPSHOT_OUTPUT = 30_000;

export interface SnapshotElement {
	ref: string;
	element: WebElement;
	tag: string;
	role: string;
	name: string;
	type: string;
	autocomplete: string;
	disabled: boolean;
	checked: boolean | null;
	href: string;
	sensitive: boolean;
}

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
	elements: SnapshotElement[];
	truncated: boolean;
}

interface RawElement {
	element: WebElement;
	tag: string;
	role: string;
	name: string;
	type: string;
	autocomplete: string;
	disabled: boolean;
	checked: boolean | null;
	href: string;
	sensitive: boolean;
}

interface RawSnapshot {
	text: string;
	elements: RawElement[];
	truncated: boolean;
}

const SNAPSHOT_SCRIPT = String.raw`
const maxElements = arguments[0];
const maxText = arguments[1];
const selector = [
  "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
  "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
  "[role=textbox]", "[role=combobox]", "[contenteditable=true]"
].join(",");
const compact = value => (value || "").replace(/\s+/g, " ").trim();
const visible = element => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
};
const inferredRole = element => {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || type === "button" || type === "submit" || type === "reset") return "button";
  if (tag === "select") return "combobox";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (tag === "input" || tag === "textarea" || element.isContentEditable) return "textbox";
  return tag;
};
const labelledText = element => {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return compact(ariaLabel);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
    if (compact(text)) return compact(text);
  }
  if (element.labels?.length) {
    const text = Array.from(element.labels).map(label => label.textContent || "").join(" ");
    if (compact(text)) return compact(text);
  }
  const wrappingLabel = element.closest("label");
  if (wrappingLabel && compact(wrappingLabel.textContent)) return compact(wrappingLabel.textContent);
  for (const attribute of ["placeholder", "alt", "title"]) {
    const value = element.getAttribute(attribute);
    if (value) return compact(value);
  }
  if (!["input", "textarea", "select"].includes(element.tagName.toLowerCase())) {
    return compact(element.innerText || element.textContent).slice(0, 240);
  }
  return "";
};
const all = Array.from(document.querySelectorAll(selector)).filter(visible);
const selected = all.slice(0, maxElements);
const elements = selected.map(element => {
  const type = (element.getAttribute("type") || "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  const name = labelledText(element).slice(0, 240);
  const identity = [element.getAttribute("name"), element.id, element.getAttribute("aria-label"), name]
    .filter(Boolean).join(" ").toLowerCase();
  const sensitive = type === "password" ||
    /(?:current-password|new-password|one-time-code|cc-csc)/.test(autocomplete) ||
    /(?:^|[-_\s])(pass(?:word|code)?|passwd|pin|secret|otp|verification[-_\s]?code)(?:$|[-_\s])/.test(identity);
  return {
    element,
    tag: element.tagName.toLowerCase(),
    role: inferredRole(element),
    name,
    type,
    autocomplete,
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    checked: type === "checkbox" || type === "radio" ? Boolean(element.checked) : null,
    href: element.tagName.toLowerCase() === "a" ? (element.href || "") : "",
    sensitive
  };
});
const bodyText = compact(document.body?.innerText || "");
return {
  text: bodyText.slice(0, maxText),
  elements,
  truncated: all.length > maxElements || bodyText.length > maxText
};
`;

export async function takeSnapshot(driver: WebDriver): Promise<BrowserSnapshot> {
	const [url, title, raw] = await Promise.all([
		driver.getCurrentUrl(),
		driver.getTitle(),
		driver.executeScript(SNAPSHOT_SCRIPT, MAX_ELEMENTS, MAX_PAGE_TEXT) as Promise<RawSnapshot>,
	]);
	const elements = raw.elements.map((entry, index) => ({ ...entry, ref: `@e${index + 1}` }));
	return { url, title, text: raw.text, elements, truncated: raw.truncated };
}

export function formatSnapshot(snapshot: BrowserSnapshot): string {
	const lines = [`# ${snapshot.title || "Untitled page"}`, `URL: ${snapshot.url}`];
	if (snapshot.text) lines.push("", snapshot.text);
	if (snapshot.elements.length > 0) {
		lines.push("", "## Interactive elements");
		for (const entry of snapshot.elements) {
			const states = [
				entry.type && entry.type !== entry.role ? `type=${entry.type}` : "",
				entry.disabled ? "disabled" : "",
				entry.checked === true ? "checked" : entry.checked === false ? "unchecked" : "",
				entry.sensitive ? "password redacted" : "",
			].filter(Boolean);
			const name = entry.name ? ` “${entry.name}”` : "";
			const state = states.length > 0 ? ` [${states.join(", ")}]` : "";
			const href = entry.href ? ` → ${entry.href}` : "";
			lines.push(`${entry.ref} ${entry.role}${name}${state}${href}`);
		}
	}
	if (snapshot.truncated) lines.push("", "[snapshot truncated]");
	const output = lines.join("\n");
	if (output.length <= MAX_SNAPSHOT_OUTPUT) return output;
	return `${output.slice(0, MAX_SNAPSHOT_OUTPUT)}\n[snapshot output truncated]`;

}
