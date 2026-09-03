import packageMetadata from '../package.json';
import { resolveBuildIdentity } from './build-identity.js';

/** package.json is the release authority consumed by both CLI and lifecycle evidence. */
export const CORTEXTOS_VERSION: string = packageMetadata.version;
export const CORTEXTOS_BUILD_SHA: string = resolveBuildIdentity().sha;
