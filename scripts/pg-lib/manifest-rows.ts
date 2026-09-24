// The mapping lives with the runtime stores (ADR 0005); scripts import it from
// here so seed:local and the #348 importer keep one spelling.
export * from "../../src/modules/stores/postgres/manifest-rows";
