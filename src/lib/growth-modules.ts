/**
 * Marketing module registry. One entry per agent-roster manager (see
 * docs/agent-roster-roadmap.md). `live: true` means the module ships
 * scoring/UI today; `live: false` renders as a "planned" placeholder
 * in the Growth page module strip.
 *
 * Adding a new module: append an entry, set `live: true` and list its
 * platform channels. The overall-score weight rebalances automatically
 * (1 / live-module-count, equal share).
 */
export type GrowthModuleId =
  | 'social'
  | 'search'
  | 'performance'
  | 'content'
  | 'analytics';

export interface GrowthModule {
  id: GrowthModuleId;
  displayName: string;
  managerTitle: string;
  live: boolean;
  channels: string[]; // platform ids — e.g. ['x', 'reddit']
}

export const GROWTH_MODULES: GrowthModule[] = [
  {
    id: 'social',
    displayName: 'Social marketing',
    managerTitle: 'Social Media Manager',
    live: true,
    channels: ['x', 'reddit'],
  },
  {
    id: 'search',
    displayName: 'Search',
    managerTitle: 'SEO Manager',
    live: false,
    channels: [],
  },
  {
    id: 'performance',
    displayName: 'Performance',
    managerTitle: 'Performance Marketing Manager',
    live: false,
    channels: [],
  },
  {
    id: 'content',
    displayName: 'Content',
    managerTitle: 'Content Marketing Manager',
    live: false,
    channels: [],
  },
  {
    id: 'analytics',
    displayName: 'Analytics',
    managerTitle: 'Marketing Analytics Manager',
    live: false,
    channels: [],
  },
];

export function liveModules(): GrowthModule[] {
  return GROWTH_MODULES.filter((m) => m.live);
}

export function getModule(id: GrowthModuleId): GrowthModule | undefined {
  return GROWTH_MODULES.find((m) => m.id === id);
}
