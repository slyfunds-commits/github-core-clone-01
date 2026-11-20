// The entrypoint owns the service lifecycle: start, register, poll, then stop.

import { createApp } from "./app.ts";

const environmentUrl = process.env.MAKEFUN_ENV_URL?.trim();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reportFailure(message, error) {
  if (error === undefined) {
    console.error(message);
  } else {
    console.error(`${message}:`, error);
  }
  process.exitCode = 1;
}

function endpoint(baseUrl, path) {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function registerServer(baseUrl, port) {
  const response = await fetch(endpoint(baseUrl, "/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`registration returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }
}

async function pollUntilFinished(baseUrl) {
  while (true) {
    try {
      const response = await fetch(endpoint(baseUrl, "/done"), { method: "GET" });
      if (!response.ok) {
        throw new Error(`poll returned HTTP ${response.status}`);
      }

      const status = await response.json();
      if (status && status.done === true) {
        return;
      }
    } catch (error) {
      console.error("Suite polling failed; retrying:", error);
    }

    await delay(1000);
  }
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  if (!environmentUrl) {
    reportFailure("MAKEFUN_ENV_URL is missing or empty");
    return;
  }

  const server = createApp();

  try {
    await waitForListening(server);
  } catch (error) {
    reportFailure("Unable to bind the server", error);
    return;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    reportFailure("Server did not produce a usable TCP port");
    await stopServer(server).catch(() => {});
    return;
  }

  try {
    await registerServer(environmentUrl, address.port);
  } catch (error) {
    reportFailure("Unable to register the server with the suite", error);
    await stopServer(server).catch(() => {});
    return;
  }

  await pollUntilFinished(environmentUrl);

  try {
    await stopServer(server);
  } catch (error) {
    reportFailure("Unable to shut down the server cleanly", error);
  }
}

await main();
