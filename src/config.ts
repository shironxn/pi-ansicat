// pi resolves extension state under PI_CODING_AGENT_DIR (default ~/.pi/agent).
// ansicat.json used to live in ~/.pi — still read, but new writes go to the
// agent dir.
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.length > 0) {
    // pi expands a leading ~ in PI_CODING_AGENT_DIR itself (dist/utils/paths.js) —
    // match it, or config/binding paths silently diverge from pi's.
    return env.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  }
  return `${process.env.HOME ?? ""}/.pi/agent`;
}

export function ansicatConfigPaths(): [current: string, legacy: string] {
  return [`${agentDir()}/ansicat.json`, `${process.env.HOME ?? ""}/.pi/ansicat.json`];
}
