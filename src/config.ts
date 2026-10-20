// ansicat.json lives in the agent dir; the legacy ~/.pi path is still read.
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.length > 0) {
    // pi expands a leading ~ itself; match it so paths do not diverge.
    return env.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  }
  return `${process.env.HOME ?? ""}/.pi/agent`;
}

export function ansicatConfigPaths(): [current: string, legacy: string] {
  return [`${agentDir()}/ansicat.json`, `${process.env.HOME ?? ""}/.pi/ansicat.json`];
}
