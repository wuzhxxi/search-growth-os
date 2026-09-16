import http from "node:http";

export async function startFixtureServer(routes) {
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url, "http://fixture.invalid").pathname];
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const selected = typeof route === "function" ? route(request) : route;
    const { status = 200, headers = {}, body = "" } = selected;
    response.writeHead(status, headers);
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}
