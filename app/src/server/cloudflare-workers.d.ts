// The one binding this Worker reads, from the Workers runtime module. Declared
// by hand rather than generating the full runtime types; see wrangler.jsonc.
declare module "cloudflare:workers" {
  export const env: {
    BACKEND: import("./backend-reads").BackendReads;
  };
}
