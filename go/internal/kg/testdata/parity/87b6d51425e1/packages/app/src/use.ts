import { knowRoot } from "@ws/knowledge";
import { knowExt } from "@ws/knowledge/extension";
import { cliRun } from "@ws/cli";
export function useAll() { return [knowRoot(), knowExt(), cliRun()]; }