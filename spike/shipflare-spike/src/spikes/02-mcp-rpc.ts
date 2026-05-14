import { getAgentByName } from "agents";
import type { AgentExample } from "../durable-objects/AgentExample";
import type { Env } from "../index";

export default async function handler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  // Optional `?name=` query param lets tests pick a unique agent instance for
  // true state isolation. Defaults to "spike-instance" for manual curl use.
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "spike-instance";
  const agent = await getAgentByName<Env, AgentExample>(
    env.AGENT_EXAMPLE,
    name,
  );
  const result = await agent.callMcpEcho("hello-rpc");
  return Response.json({ result });
}
