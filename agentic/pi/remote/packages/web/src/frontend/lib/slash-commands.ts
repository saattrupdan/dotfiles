import type { Command, Session } from "../../../../protocol/src/index.ts";

type Capability = Session["capabilities"][number];

export function slashQuery(text: string): string | undefined {
  return /^\/([^\s/]*)$/.exec(text)?.[1]?.toLowerCase();
}

export function matchingCommands(text: string, commands: Capability[]): Capability[] {
  const query = slashQuery(text);
  if (query === undefined) return [];
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .sort(
      (a, b) =>
        Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name),
    );
}

export function composerCommand(
  text: string,
  images: string[],
  commands: Capability[],
): Command {
  if (text === "/") throw new Error("Choose a slash command first.");
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { action: "message", text, images };
  const name = match[1]!;
  const command = commands.find((command) => command.name === name);
  if (!command) throw new Error(`Unknown command /${name}.`);
  if (!command.supported)
    throw new Error(command.reason || `/${name} is only available on your laptop.`);
  if (images.length)
    throw new Error("Remove attached images before running a slash command.");
  return { action: "slash", name, args: match[2] ?? "" };
}
