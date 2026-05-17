import { EMPLOYEE_REGISTRY, type EmployeeId } from '../registry';

export function getEmployee<TEnv extends Record<string, unknown>>(
	id: EmployeeId,
	userId: string,
	env: TEnv,
): DurableObjectStub {
	const meta = EMPLOYEE_REGISTRY[id];
	if (!meta) throw new Error(`Unknown employee id: ${id}`);
	const ns = env[meta.envBinding] as DurableObjectNamespace | undefined;
	if (!ns) throw new Error(`Env missing DO binding for ${meta.envBinding}`);
	return ns.get(ns.idFromName(userId));
}
