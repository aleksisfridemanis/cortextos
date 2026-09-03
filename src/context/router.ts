import { join } from 'path';
import type { ContextRoute } from './types.js';

export interface EmployeeContextRouteOptions {
  ctxRoot: string;
  agentDir: string;
  projectRoot?: string;
}

export function buildEmployeeContextRoutes(options: EmployeeContextRouteOptions): ContextRoute[] {
  return [
    { kind: 'identity', source_ref: join(options.agentDir, 'IDENTITY.md'), load_when: 'always in the composed core', precedence: 30 },
    { kind: 'memory', source_ref: join(options.agentDir, 'MEMORY.md'), load_when: 'only when active work needs durable personal memory', precedence: 50 },
    { kind: 'tools', source_ref: 'logical://runtime/tools', load_when: 'discover at point of use; never snapshot inventories', precedence: 60 },
    { kind: 'skills', source_ref: 'logical://runtime/skills', load_when: 'discover at point of use; never snapshot inventories', precedence: 60 },
    { kind: 'project_instructions', source_ref: options.projectRoot ? join(options.projectRoot, 'AGENTS.md') : 'logical://project/instructions', load_when: 'when operating inside the selected project', precedence: 40 },
    { kind: 'current_work', source_ref: join(options.ctxRoot, 'state', 'current-work.json'), load_when: 'continuation only through one handoff lease', precedence: 70 },
  ];
}
