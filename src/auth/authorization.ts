import type { Context } from "./context";

export function requireAuth(context: Context) {
  if (!context.user) {
    throw new Error("Authentication required");
  }

  return context.user;
}

export function requireRole(
  context: Context,
  roles: Array<"USER" | "AGENT" | "ADMIN">
) {
  const user = requireAuth(context);

  if (!roles.includes(user.role)) {
    throw new Error("You are not authorized to perform this action");
  }

  return user;
}