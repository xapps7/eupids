import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { startWorker } from "./lib/worker.server";

// Background jobs, scan polling and cleanup run in the server process.
startWorker();

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  // NFR Supplier page: noindex, no referrer (the token is in the URL), no caching, CSP.
  if (new URL(request.url).pathname.startsWith("/s/")) {
    responseHeaders.set("X-Robots-Tag", "noindex, nofollow");
    responseHeaders.set("Referrer-Policy", "no-referrer");
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    if (process.env.NODE_ENV === "production") {
      responseHeaders.set(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' https://cdn.shopify.com data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.shopify.com; font-src https://cdn.shopify.com; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      );
    }
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
