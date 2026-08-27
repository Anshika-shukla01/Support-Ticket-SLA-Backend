import { yoga } from "./src/server";
import { bootstrapAdmin } from "./src/auth/bootstrapAdmin";

await bootstrapAdmin();

const server = Bun.serve({
    port: 4000,
    fetch: yoga,
});

console.log(
    `GraphQL server running at http://localhost:${server.port}/graphql`
);