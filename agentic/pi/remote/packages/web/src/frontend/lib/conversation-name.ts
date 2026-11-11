export function isUntitled(name?: string): boolean {
  return name?.trim().toLowerCase() === "untitled";
}
