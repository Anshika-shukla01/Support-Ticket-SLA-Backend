import { yoga } from "./src/server";

const server = Bun.serve({
  port: 4000,
  fetch: yoga,
});

console.log(
  `GraphQL server running at http://localhost:${server.port}/graphql`
);