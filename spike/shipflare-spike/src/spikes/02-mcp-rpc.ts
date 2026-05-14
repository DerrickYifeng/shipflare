import { getAgentByName } from "agents";
import type { Env } from "../index";

export default async function handler(
  _req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const agent = await getAgentByName(env.AGENT_EXAMPLE, "spike-instance");
  const result = await (agent as unknown as {
    callMcpEcho(ping: string): Promise<unknown>;
  }).callMcpEcho("hello-rpc");
  return Response.json({ result });
}
