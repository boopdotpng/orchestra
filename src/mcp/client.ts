export class OrchestraClientError extends Error {}

const HOST = process.env.ORCHESTRA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ORCHESTRA_PORT ?? "5751");
export const BASE_URL = process.env.ORCHESTRA_URL ?? `http://${HOST}:${PORT}`;

export async function get(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`);
  return parseResponse(response);
}

export async function post(path: string, data: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return parseResponse(response);
}

export async function getText(path: string): Promise<string> {
  const response = await fetch(`${BASE_URL}${path}`);
  if (!response.ok) {
    throw new OrchestraClientError(await response.text());
  }
  return response.text();
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `HTTP ${response.status}`;
    throw new OrchestraClientError(message);
  }
  return data;
}
