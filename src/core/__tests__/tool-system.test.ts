import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/core/tool-system';

describe('ToolRegistry.getAllToolNames', () => {
  it('returns the registered tool names', () => {
    const reg = new ToolRegistry();
    // Use minimal stubs satisfying AnyToolDefinition's structural shape.
    // The cast `as never` works because we're only registering for name lookup —
    // no method on AnyToolDefinition is called by getAllToolNames.
    reg.register({ name: 'A' } as never);
    reg.register({ name: 'B' } as never);
    expect(new Set(reg.getAllToolNames())).toEqual(new Set(['A', 'B']));
  });

  it('returns empty array on empty registry', () => {
    const reg = new ToolRegistry();
    expect(reg.getAllToolNames()).toEqual([]);
  });
});
