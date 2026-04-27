export interface Env {
  READINGS_BUCKET: R2Bucket;
  READINGS_INDEX: VectorizeIndex;
  READER_API_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  CORS_ALLOWED_ORIGINS: string;
  PENDING_TTL_SECONDS: string;
  FETCH_TIMEOUT_MS: string;
  FETCH_MAX_BYTES: string;
  ANTHROPIC_MODEL: string;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  },
};
