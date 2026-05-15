import { z } from "zod";

export const McpPropsSchema = z.object({
  userId: z.string(),
  conversationId: z.string().optional(),
  caller: z.enum(["cmo", "external", "peer", "cron"]),
  role: z.enum(["lead", "member"]).optional(),
});

export type McpProps = z.infer<typeof McpPropsSchema>;

export function assertMcpProps(props: unknown): McpProps {
  return McpPropsSchema.parse(props);
}
