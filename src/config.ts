// pi resolves extension state under PI_CODING_AGENT_DIR (default ~/.pi/agent).
// ansicat.json predates that convention and lived directly in ~/.pi; the
// legacy path is still read so an existing config keeps working, but new
// writes go to the agent dir.
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.length > 0) return env;
  return `${process.env.HOME ?? ""}/.pi/agent`;
}

export function ansicatConfigPaths(): [current: string, legacy: string] {
  return [`${agentDir()}/ansicat.json`, `${process.env.HOME ?? ""}/.pi/ansicat.json`];
}
