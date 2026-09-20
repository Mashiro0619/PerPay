import type { Connect, Plugin } from "vite";

export function redirectBasePath(base: string): Connect.NextHandleFunction {
  const bareBase = base.slice(0, -1);
  return (request, response, next) => {
    if (
      base === "/" ||
      !request.url ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      next();
      return;
    }
    const queryIndex = request.url.indexOf("?");
    const pathname =
      queryIndex < 0 ? request.url : request.url.slice(0, queryIndex);
    if (pathname !== bareBase) {
      next();
      return;
    }
    const search = queryIndex < 0 ? "" : request.url.slice(queryIndex);
    response.writeHead(302, {
      Location: base + search,
      "Cache-Control": "no-store",
    });
    response.end();
  };
}

export function adminBasePath(): Plugin {
  return {
    name: "perpay-admin-base-path",
    apply: "serve",
    configureServer(server) {
      // Register before Vite rejects a request that omits the base's trailing slash.
      server.middlewares.use(redirectBasePath(server.config.base));
    },
  };
}
