import { createYoga, createSchema } from "graphql-yoga";
import { GraphQLError } from "graphql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvers } from "./graphql/resolvers";
import { createContext } from "./auth/context";
import { AppError } from "./graphql/errors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const typeDefs = readFileSync(
  join(__dirname, "graphql", "schema.graphql"),
  "utf-8"
);

export const yoga = createYoga({
  schema: createSchema({
    typeDefs,
    resolvers,
  }),
  context: createContext,
  maskedErrors: {
    maskError(error, message) {
      // graphql v17 keeps the original thrown error in `cause`
      const original =
        (error as GraphQLError).originalError ??
        (error as GraphQLError).cause ??
        error;

      if (original instanceof AppError) {
        return original; // safe to show to the client
      }

      console.error(error); // real bugs stay hidden, but get logged
      return new GraphQLError(message, {
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      });
    },
  },
});