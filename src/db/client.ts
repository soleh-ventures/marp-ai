import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

const client = postgres(config.databaseUrl, {
  max: config.nodeEnv === "production" ? 10 : 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client);
export const sqlClient = client;

export async function ping(): Promise<boolean> {
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  }
}
