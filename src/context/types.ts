export type ContextOwner = 'framework' | 'instance' | 'owner' | 'ambiguous';
export type ContextLaunchMode = 'fresh' | 'continuation';
export type ContextRouteKind =
  | 'tools'
  | 'skills'
  | 'memory'
  | 'project_instructions'
  | 'identity'
  | 'current_work';

export interface ContextProvenanceEntry {
  source_ref: string;
  digest: string;
  owner: ContextOwner;
  inclusion_reason: string;
}

export interface ContextRoute {
  kind: ContextRouteKind;
  source_ref: string;
  load_when: string;
  precedence: number;
}

export interface EffectiveContextBlock {
  source_ref: string;
  text: string;
  owner: ContextOwner;
  inclusion_reason: string;
}

export interface EffectiveContextPacket {
  schema_version: 1;
  builder_version: '1';
  launch_mode: ContextLaunchMode;
  blocks: EffectiveContextBlock[];
  routes: ContextRoute[];
  provenance: ContextProvenanceEntry[];
  text: string;
  byte_length: number;
}
