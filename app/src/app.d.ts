declare global {
  namespace App {
    // The Worker host one page render shares; see $lib/server/host HostLease.
    interface Locals { hostLease?:{ host:Record<'http'|'mcp',(request:Request)=>Promise<Response>>; retire:()=>void; retired:()=>boolean } }
    interface Platform {
      env: {
        ORIGINALS: R2Bucket;
        STATEPLANE_ENV: string;
        STATEPLANE_TEST_HTTP?: string;
        STATEPLANE_TEST_TOKEN?: string;
        STATEPLANE_TEST_OWNER?: string;
        STATEPLANE_TEST_CREDENTIAL?: string;
        STATEPLANE_TEST_AGENT_TOKEN?: string;
        STATEPLANE_TEST_AGENT_CREDENTIAL?: string;
        STATEPLANE_TEST_DATABASE_URL?: string;
        STATEPLANE_TEST_CURSOR_SECRET?: string;
        STATEPLANE_TEST_CELL_ID?: string;
        STATEPLANE_TEST_STORAGE_TARGET?: string;
        STATEPLANE_TEST_PROVIDER_FAULT_URL?: string;
        STATEPLANE_MCP_AUTHORIZATION_SERVER?: string;
        STATEPLANE_MCP_RESOURCE?: string;
        AUTHORITY?: Hyperdrive;
      };
    }
  }
}

export {};
