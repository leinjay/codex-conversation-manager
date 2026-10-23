import * as path from 'node:path';
import type { BuildProfile } from './core';
import type { HostIdentity } from './hostProcess';

export const runSessionKey = 'zw3d.runSession.v1';
export interface RunSession {
    id: string; root: string; profile: BuildProfile;
    state: 'preparing' | 'building' | 'starting' | 'running' | 'paused' | 'stopping' | 'exited' | 'failed';
    pid?: number; startedAt?: number; endedAt?: number; detail?: string; stopRequested?: boolean;
    identity?: HostIdentity;
}

/** Persisted data must be validated before it can grant process controls. */
export function savedRunSession(value: unknown): RunSession | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const record = value as RunSession;
    if (typeof record.id !== 'string' || !record.id || typeof record.root !== 'string' || !path.isAbsolute(record.root)
        || !['Release', 'Debug'].includes(record.profile)
        || !['preparing', 'building', 'starting', 'running', 'paused', 'stopping', 'exited', 'failed'].includes(record.state)) { return undefined; }
    for (const timestamp of [record.startedAt, record.endedAt]) {
        if (timestamp !== undefined && (!Number.isFinite(timestamp) || timestamp < 0)) { return undefined; }
    }
    if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid <= 1)) { return undefined; }
    if (record.detail !== undefined && typeof record.detail !== 'string') { return undefined; }
    const identity = record.identity;
    if (identity && (identity.pid !== record.pid || !Number.isSafeInteger(identity.pid) || identity.pid <= 1
        || typeof identity.bootId !== 'string' || !identity.bootId
        || typeof identity.startTicks !== 'string' || !/^\d+$/.test(identity.startTicks)
        || typeof identity.executable !== 'string' || !path.isAbsolute(identity.executable)
        || record.startedAt === undefined)) { return undefined; }
    // Copy only known fields; an identity-less record cannot be reattached.
    return { id: record.id, root: record.root, profile: record.profile, state: record.state,
        pid: record.pid, startedAt: record.startedAt, endedAt: record.endedAt, detail: record.detail,
        ...(identity ? { identity: { pid: identity.pid, bootId: identity.bootId, startTicks: identity.startTicks, executable: identity.executable } } : {}) };
}
