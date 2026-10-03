#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { PRODUCT_NAME } from "../constants";
import { CbError } from "../shared/errors";
import { registerStatusCommand } from "./commands/status";

// dist/cli/index.js → package root
const { version } = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
  version: string;
};

const program = new Command().name(PRODUCT_NAME).version(version).showHelpAfterError();

registerStatusCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const correlation = err instanceof CbError && err.correlationId ? `\ncorrelation id: ${err.correlationId}` : "";
  process.stderr.write(`${message}${correlation}\n`);
  process.exit(err instanceof CbError ? err.exitCode : 1);
});
