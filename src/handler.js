import { Server } from "SERVER";
import { manifest } from "MANIFEST";
import { build_options, env } from "./env";
import { fileURLToPath } from "bun";
import path from "path";
import sirv from "./sirv";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

/** @type {import('@sveltejs/kit').Server} */
const server = new Server(manifest);
await server.init({ env: (Bun || process).env });

const xff_depth = parseInt(env("XFF_DEPTH", build_options.xff_depth ?? 1));
const origin = env("ORIGIN", undefined);

const address_header = env("ADDRESS_HEADER", "").toLowerCase();
const protocol_header = env("PROTOCOL_HEADER", "").toLowerCase();
const host_header = env("HOST_HEADER", "").toLowerCase();
const log_req = env("LOGREQ", "").toLowerCase() === "true";

/** @param {boolean} assets */
export default function (assets) {
  let handlers = [
    assets && serve(path.join(__dirname, "/client"), true),
    assets && serve(path.join(__dirname, "/prerendered")),
    ssr,
  ].filter(Boolean);

  /**
   * @param {Request} req
   * @param {import('bun').Server} srv
   */
  function handler(req, srv) {
    function handle(i) {
      return handlers[i](
        req,
        () => {
          if (i < handlers.length) {
            return handle(i + 1);
          } else {
            return new Response(404, { status: 404 });
          }
        },
        srv,
      );
    }
    return handle(0);
  }

  /**
   * @param {Request} request 
   * @param {import('bun').Server} server 
   * @returns 
   */
  function defaultAcceptWebsocket(request, server) {
    return server.upgrade(request);
  }

  try {
    const handleWebsocket = server.websocket();
    if (handleWebsocket) {
      return {
        httpserver: async (req, srv) => {
          if (
            req.headers.get("connection")?.toLowerCase().includes("upgrade") &&
            req.headers.get("upgrade")?.toLowerCase() === "websocket"
          ) {
            if(!await (handleWebsocket.upgrade ?? defaultAcceptWebsocket)(req, srv)){};
            return;
          }
          return handler(req, srv);
        },
        websocket: handleWebsocket,
      };
    }
  } catch (e) {
    console.warn("Fail: websocket handler error:", e);
  }
  return {
    httpserver: handler,
  };
}

function serve(path, client = false) {
  return (
    existsSync(path) &&
    sirv(path, {
      etag: true,
      gzip: true,
      brotli: true,
      setHeaders:
        client &&
        ((headers, pathname) => {
          if (pathname.startsWith(`/${manifest.appDir}/immutable/`)) {
            headers.set("cache-control", "public,max-age=31536000,immutable");
          }
          return headers;
        }),
    })
  );
}

/**
 * @param {Request} request
 * @param {import('bun').Server} bunServer
 */
function ssr(request, _, bunServer) {
  const clientIp = bunServer.requestIP(request)?.address;
  // For debugging
  if (log_req) {
    console.log("request", {
      clientIp,
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
    });
  }

  const url = new URL(request.url);
  let req = request;

  if (origin) {
    const new_url = new URL(origin);
    new_url.pathname = url.pathname;
    new_url.search = url.search;
    new_url.hash = url.hash;
    req = clone_req(new_url, request);
  } else if (
    (host_header && url.host !== request.headers.get(host_header)) ||
    (protocol_header && url.protocol !== request.headers.get(protocol_header) + ":")
  ) {
    if (host_header) {
      url.host = request.headers.get(host_header);
    }
    if (protocol_header) {
      url.protocol = request.headers.get(protocol_header) + ":";
    }
    req = clone_req(url, request);
  }

  if (address_header && !request.headers.has(address_header)) {
    throw new Error(
      `Address header was specified with ${
        ENV_PREFIX + "ADDRESS_HEADER"
      }=${address_header} but is absent from request`,
    );
  }

  return server.respond(req, {
    getClientAddress() {
      if (address_header) {
        const value = /** @type {string} */ (request.headers.get(address_header)) || "";

        if (address_header === "x-forwarded-for") {
          const addresses = value.split(",");

          if (xff_depth < 1) {
            throw new Error(`${ENV_PREFIX + "XFF_DEPTH"} must be a positive integer`);
          }

          if (xff_depth > addresses.length) {
            throw new Error(
              `${ENV_PREFIX + "XFF_DEPTH"} is ${xff_depth}, but only found ${
                addresses.length
              } addresses`,
            );
          }
          return addresses[addresses.length - xff_depth].trim();
        }

        return value;
      }
      return clientIp ?? "127.0.0.1";
    },
    platform: {
      get isBun() {
        return true;
      },
      get bunServer() {
        return bunServer;
      },
      get originalRequest() {
        return request;
      },
    },
  });
}

/**
 * @param {string|URL} url
 * @param {Request} request
 * @returns {Request}
 */
function clone_req(url, request) {
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    integrity: request.integrity,
  });
}
