// Jev credential and home resolution for OMP extensions. Values never enter logs or process.env.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The owning Firstmate home: FM_HOME, then FM_ROOT_OVERRIDE, then the repository containing the extension. */
export function jevHome(extensionFile: string): string {
  return process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || resolve(dirname(extensionFile), "../..");
}

export function resolveTypesafeKey(extensionFile: string): string | null {
  return process.env.TYPESAFE_API_KEY || envFileValue(`${jevHome(extensionFile)}/.env`, "TYPESAFE_API_KEY") || null;
}
/**
 * The one-key .env read of bin/fm-env-lib.sh's fmx_env_get: the last
 * `KEY=` assignment wins, a leading `export ` and surrounding whitespace are
 * tolerated, one layer of matching quotes is stripped, and an absent file or
 * key yields "".
 */
export function envFileValue(file: string, key: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
  let value = "";
  for (const line of text.split(/\r?\n/)) {
    const match = assignment.exec(line);
    if (match) value = match[1].trim();
  }
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return value;
}
