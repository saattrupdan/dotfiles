/** Phone folder navigation is restricted to the Mac's user directories. */
export function isUsersDirectory(cwd: string | undefined): cwd is string {
  if (!cwd?.startsWith("/Users/")) return false;
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 1 && !parts.some((part) => part === "." || part === "..");
}
