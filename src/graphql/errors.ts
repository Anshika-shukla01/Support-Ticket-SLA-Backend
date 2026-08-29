import { GraphQLError } from "graphql";

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  TICKET_NOT_FOUND: "TICKET_NOT_FOUND",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  CONFLICT: "CONFLICT",
} as const;

export type ErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends GraphQLError {
  constructor(
    message: string,
    code: ErrorCode
  ) {
    super(message, {
      extensions: {
        code,
      },
    });
  }
}