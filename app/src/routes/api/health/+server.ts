import { healthResponse } from '@stateplane/api';

/** Return scaffold health without claiming operational readiness. */
export function GET() { return healthResponse(); }
