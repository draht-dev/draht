#!/usr/bin/env node
import { main } from "../eval/drahtbank/cli.mjs";

process.exitCode = await main();
