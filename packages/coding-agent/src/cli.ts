#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 */
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
