// The migrate path's client contracts now live in the shared cf-clients module
// (used by both migrate.ts and corpus-recover --batch). Re-exported here so
// existing imports under migrate-lib keep working.
export type {
  R2PutOptions,
  R2Client,
  VectorizeUpsertVector,
  VectorizeClient,
} from "../lib/cf-clients";
