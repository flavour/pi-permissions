/**
 * Loopback decision endpoint used by the client tests.
 *
 * This replaces the reference project's Python mock endpoint so the offline
 * suite has no second runtime. It is deliberately bad: malformed JSON, wrong
 * identity, out-of-range and missing answers, unexpected keys, broken
 * distributions, HTTP errors, delays and abrupt disconnects. A client that
 * survives only the well-formed case has not been tested.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Behaviour =
  | { kind: "json"; body: unknown; status?: number; delayMs?: number }
  | { kind: "malformed"; text: string; delayMs?: number }
  | { kind: "status"; status: number; body?: string }
  | { kind: "delay"; ms: number }
  | { kind: "disconnect" };

export interface FixtureEndpoint {
  readonly url: string;
  readonly requests: readonly unknown[];
  readonly bodies: readonly string[];
  reset(behaviour: Behaviour | Behaviour[]): void;
  close(): Promise<void>;
}

export async function startEndpoint(
  first: Behaviour | Behaviour[] = { kind: "json", body: {} },
): Promise<FixtureEndpoint> {
  const requests: unknown[] = [];
  const bodies: string[] = [];
  let behaviours: Behaviour[] = Array.isArray(first) ? [...first] : [first];
  let index = 0;
  let server: Server | undefined;

  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        bodies.push(raw);
        try {
          requests.push(JSON.parse(raw));
        } catch {
          requests.push(raw);
        }
        // The last scripted behaviour repeats, so a test that does not care how
        // many calls a profile makes still gets a well-formed answer every time.
        const behaviour = behaviours[
          Math.min(index, behaviours.length - 1)
        ] ?? {
          kind: "json" as const,
          body: {},
        };
        index += 1;
        const send = (): void => {
          switch (behaviour.kind) {
            case "json":
              res.writeHead(behaviour.status ?? 200, {
                "content-type": "application/json",
              });
              res.end(JSON.stringify(behaviour.body));
              return;
            case "malformed":
              res.writeHead(200, { "content-type": "application/json" });
              res.end(behaviour.text);
              return;
            case "status":
              res.writeHead(behaviour.status, { "content-type": "text/plain" });
              res.end(
                behaviour.body ?? "endpoint failure detail that must not leak",
              );
              return;
            case "delay":
              // Never answer: the client's own deadline must end this request.
              return;
            case "disconnect":
              req.socket.destroy();
              return;
          }
        };
        if (behaviour.kind === "json" || behaviour.kind === "malformed") {
          const delayMs = behaviour.delayMs ?? 0;
          if (delayMs > 0) setTimeout(send, delayMs);
          else send();
          return;
        }
        if (behaviour.kind === "delay") {
          setTimeout(send, behaviour.ms + 5000);
          return;
        }
        send();
      });
    });
    (server as Server).listen(0, "127.0.0.1", () => resolve());
  });

  const instance = server as Server;
  const address = instance.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    bodies,
    reset(behaviour) {
      behaviours = Array.isArray(behaviour) ? [...behaviour] : [behaviour];
      index = 0;
    },
    async close() {
      await new Promise<void>((resolve) => {
        instance.closeAllConnections();
        instance.close(() => resolve());
      });
    },
  };
}

/** A well-formed response for the noul profile, with one field replaceable. */
export function noulResponse(
  readings: Readonly<Record<string, number>>,
  model = "LiquidAI/d1-2B-GGUF:Q8_0",
): unknown {
  return {
    model,
    answers: Object.fromEntries(
      Object.entries(readings).map(([key, noul]) => [
        key,
        { type: "noul", noul },
      ]),
    ),
    usage: { input_tokens: 120, output_tokens: 0 },
  };
}

export function choiceResponse(
  choice: string,
  probabilities: Readonly<Record<string, number>>,
  model = "LiquidAI/d1-2B-GGUF:Q8_0",
): unknown {
  return {
    model,
    answers: {
      decision: { type: "choice", choice, probabilities, confidence: 0.8 },
    },
    usage: { input_tokens: 90, output_tokens: 1 },
  };
}
