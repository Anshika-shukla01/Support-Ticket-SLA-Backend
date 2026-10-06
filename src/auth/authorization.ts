import type { Context } from "./context";
import { AppError, ERROR_CODES } from "../graphql/errors";

export function requireAuth(context: Context) {
  if(!context.user) {
    throw new AppError("Authentication required", ERROR_CODES.UNAUTHORIZED);
  }
  return context.user;
}

export function requireRole(
  context: Context,
  roles: Array<"USER" | "AGENT" | "ADMIN">
) {
  const user = requireAuth(context);

  if(!roles.includes(user.role)) {
    throw new AppError(
      "You are not authorized to perform this action",
      ERROR_CODES.FORBIDDEN
    );
  }

  return user;
}