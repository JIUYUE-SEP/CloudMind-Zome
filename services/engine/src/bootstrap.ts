import { createServer } from "./api/server.js";

async function main() {
  const app = await createServer();
  await app.listen({ port: Number(process.env.PORT || 8848), host: "127.0.0.1" });
  console.log(`Engine listening on ${app.server.address()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
